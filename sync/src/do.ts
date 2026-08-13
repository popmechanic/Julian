// sync/src/do.ts — JulianSyncDO: schema'd store, v9 fragmented SQLite persister,
// cell-size guard, and the witnessed export path (dream 0006, constraint 2).
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { createMiddleware, getHash } from 'tinybase';
import type { Middleware, Cell, Changes } from 'tinybase';
import type { MergeableStore } from 'tinybase/mergeable-store';
import { createStreamStore } from 'julian-shared/schema';
import { SYNC_AUTH_HEADER, type SyncAuthPayload } from 'julian-shared/gate-contract';
import { SOCKET_REQUIRED_MSG, SOCKET_SCOPES } from 'julian-shared/scopes';
import { introspectByHandle, type Env, type LeaseIntrospection } from './auth';

/**
 * What an accepted socket carries across hibernation: identity by HANDLE, and
 * nothing that could be replayed. A raw bearer is never serialized into an
 * attachment on any socket class — a durable object's attachment outlives the
 * request that made it, so a token stored there is a credential lying around
 * for as long as the socket lives.
 *
 * The handles are enough to re-ask the gate (`introspectByHandle`), which is
 * the only thing the DO ever needed the token for.
 */
export interface SocketAttachment {
  leaseId: string;
  tokenId?: string;
  subject?: string;
  exp?: number;
  flow: string;
  verifiedAt: number;
  // Consecutive indefinite answers seen by the alarm sweep; reset to 0 by any
  // successful re-auth. Three in a row closes the socket 4002.
  indefiniteSweeps: number;
}

// Traffic-driven re-auth: an idle socket can't act, so bounding the
// revocation SLA to "5 minutes of activity" (rather than wall-clock) is the
// right shape here — every inbound sync message piggybacks a freshness check.
const REAUTH_INTERVAL_MS = 300_000;

// A socket is a write surface: TinyBase sync is bidirectional (a socket
// client can push ContentDiff / ContentHashes and answer diff requests, and
// the DO relays client↔client), so only a socket-capable scope holds one —
// defense in depth alongside the router's upgrade-time check
// (sync/src/index.ts), since the router is no longer the only guard once
// multiple scopes share the register. The set and the sentence both come from
// the shared vocabulary; sync owns no private copy of the table.

// Close codes. 4004 is deliberately distinct from 4001: a browser whose
// exchange lease is alive but whose access token aged out should re-exchange
// and come back, while a revoked lease is terminal and the app must stop.
const CLOSE_REVOKED = 4001;
const CLOSE_INDEFINITE = 4002;
const CLOSE_SCOPE_LOST = 4003;
const CLOSE_TOKEN_EXPIRED = 4004;

const REVOKED_MSG = 'lease revoked';
const INDEFINITE_MSG = 'introspection unavailable';
const TOKEN_EXPIRED_MSG = 'access token expired — re-exchange';

// The alarm sweep is the wall-clock backstop for a socket that never sends
// traffic: the traffic-driven re-auth above only fires on an inbound
// message, so a silent receiver could otherwise sit past a governor kill
// indefinitely. The sweep re-checks every attached socket on this fixed
// interval, cache bypassed, regardless of how recently (or never) it last
// spoke — the third of the honest SLA's three numbers (spec §6.2).
const SWEEP_INTERVAL_MS = 300_000;

// A single gate blip must not mass-close the fleet into a synchronized
// ticket-mint storm against a recovering gate: an indefinite answer is
// tolerated for this many CONSECUTIVE sweeps before the socket is closed.
const SWEEP_INDEFINITE_STRIKES = 3;
const SWEEP_INDEFINITE_MSG = 'introspection unavailable across 3 sweeps';

/**
 * The router's handoff, turned into a fresh attachment. The DO trusts this
 * header because the router strips every inbound copy of it as its first act
 * and writes its own only after the gate has vouched for the credential.
 *
 * Returns null for a missing or unusable handoff — the caller refuses rather
 * than accepting a socket it could never re-auth.
 */
function readSyncAuth(request: Request): SocketAttachment | null {
  const raw = request.headers.get(SYNC_AUTH_HEADER);
  if (raw === null) return null;
  let payload: SyncAuthPayload;
  try {
    payload = JSON.parse(raw) as SyncAuthPayload;
  } catch {
    return null;
  }
  if (typeof payload?.leaseId !== 'string' || typeof payload?.flow !== 'string') return null;
  return {
    leaseId: payload.leaseId,
    ...(typeof payload.tokenId === 'string' ? { tokenId: payload.tokenId } : {}),
    ...(typeof payload.subject === 'string' ? { subject: payload.subject } : {}),
    ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
    flow: payload.flow,
    verifiedAt: Date.now(),
    indefiniteSweeps: 0,
  };
}

/**
 * The by-handle question this attachment can ask the gate — the legacy window
 * asks by `sub`+`exp`, everything else by `lease_id`(+`token_id`).
 *
 * Null means the attachment cannot form a question at all. That is an
 * *unanswerable* socket, not a refused one: the caller closes 4002, never
 * 4001, because "I couldn't ask" must never be reported as "the gate said no".
 */
function handleForm(attachment: SocketAttachment): Record<string, string> | null {
  if (attachment.flow === 'legacy') {
    return attachment.subject && attachment.exp !== undefined
      ? { sub: attachment.subject, exp: String(attachment.exp), kind: 'legacy' }
      : null;
  }
  return attachment.leaseId
    ? {
        lease_id: attachment.leaseId,
        ...(attachment.tokenId !== undefined ? { token_id: attachment.tokenId } : {}),
      }
    : null;
}

/**
 * Which close an inactive by-handle answer earns: 4001 (terminal — the lease
 * itself is gone) or 4004 (recoverable — the minting access token merely aged
 * out). Two signals decide it, in this order.
 *
 * The gate's `reason:'token-expired'` is authoritative wherever it appears: it
 * is the register's own reading of its own rows, on any flow.
 *
 * Absent it, an `exchange` attachment can still answer the question by itself.
 * It carries `exp`, the expiry of the very access token that minted the socket,
 * as the gate stated it at upgrade time (seconds since the epoch, JWT
 * convention). An inactive answer arriving after that moment is an aged token,
 * not a revocation — and telling a live Pocket ID session it was revoked is a
 * terminal lie that stops the app. Getting it wrong the other way costs
 * nothing: 4004 grants no access, it only sends the browser back to
 * `POST /exchange`, which is the authority and answers a genuinely revoked
 * session with its own terminal `class:"revoked"`.
 *
 * No other flow infers it. "Re-exchange" is the browser's recovery and only the
 * browser's; a device door refreshes, and for it the gate must be the one to
 * speak.
 */
function inactiveClose(
  attachment: SocketAttachment, reason: string | undefined, now: number,
): { code: number; message: string } {
  const expired =
    reason === 'token-expired' ||
    (attachment.flow === 'exchange' &&
      attachment.exp !== undefined &&
      attachment.exp * 1000 <= now);
  return expired
    ? { code: CLOSE_TOKEN_EXPIRED, message: TOKEN_EXPIRED_MSG }
    : { code: CLOSE_REVOKED, message: REVOKED_MSG };
}

// Cloudflare's WS message cap is ~1 MiB; every synchronizer sets an explicit fragment size.
const FRAGMENT_SIZE = 262_144; // 256 KiB
// Any single cell whose JSON serialization exceeds this many bytes is rejected at the write boundary.
const MAX_CELL_JSON_BYTES = 65_536; // 64 KiB

// Written in place of a cell the guard rejected, so the drop leaves a receipt
// in the record instead of an indistinguishable empty string.
const DROPPED_MARKER = '[dropped: cell exceeded 64 KiB]';

const ENCODER = new TextEncoder();
const cellJsonBytes = (cell: Cell): number => ENCODER.encode(JSON.stringify(cell ?? '')).length;

export interface ExportedContent {
  mergeableContent: unknown;
  contentHash: number;
  ledgerId: string | null;
  exportedAt: string;
}

export class JulianSyncDO extends WsServerDurableObject<Env> {
  // Assigned in createPersister, which the parent constructor invokes (inside
  // blockConcurrencyWhile) BEFORE subclass field initializers would run — so the
  // store must NOT be a field initializer, or it would be constructed undefined
  // there and then silently overwritten with a second, unpersisted store.
  store!: MergeableStore;
  #middleware?: Middleware;
  // Cells stripped by the merge guard, awaiting an authoritative rewrite:
  // "<tableId> <rowId> <cellId>" -> the incoming cell's typeof.
  #oversized = new Map<string, string>();
  #flushing = false;

  createPersister() {
    this.store = createStreamStore();
    this.installGuards();
    // v9 fragmented mode = row-level SQLite layout (avoids Cloudflare's 2 MB row
    // limit). Never downgrade tinybase below 9 — the on-disk layout is breaking.
    return createDurableObjectSqlStoragePersister(this.store, this.ctx.storage.sql, {
      mode: 'fragmented',
    });
  }

  // Match the client fragment size so large payloads never exceed the WS cap.
  getFragmentSize(): number {
    return FRAGMENT_SIZE;
  }

  installGuards() {
    // Middleware (TinyBase v8+): reject any single cell whose JSON exceeds the
    // byte cap. Returning undefined from the callback rejects the write, leaving
    // the prior cell value intact.
    this.#middleware = createMiddleware(this.store);
    this.#middleware.addWillSetCellCallback((_tableId, _rowId, _cellId, cell) =>
      cellJsonBytes(cell) <= MAX_CELL_JSON_BYTES ? cell : undefined,
    );
    // Synchronizer merges (the DO's dominant write path) bypass willSetCell and
    // arrive through willApplyChanges as plain [tables, values, 1] with CRDT
    // stamps already stripped. Strip only the oversized cells so the rest of
    // the merge still lands; undefined entries are deletions and pass through.
    //
    // Stripping here only edits the plain store: applyMergeableChanges has
    // already merged the value into the stamp tree, which is what the
    // persister, the export, and every replica read. So the stripped cells are
    // recorded and authoritatively rewritten once the transaction finishes —
    // that write carries a newer HLC than the incoming one and converges the
    // oversized value away everywhere, instead of leaving the server's view
    // permanently disagreeing with each replica's.
    this.#middleware.addWillApplyChangesCallback(([tables, values, marker]) => {
      let dropped = false;
      const guarded: typeof tables = {};
      for (const [tableId, table] of Object.entries(tables ?? {})) {
        if (!table) {
          guarded[tableId] = table;
          continue;
        }
        const guardedTable: typeof table = {};
        for (const [rowId, row] of Object.entries(table)) {
          if (!row) {
            guardedTable[rowId] = row;
            continue;
          }
          const guardedRow: typeof row = {};
          for (const [cellId, cell] of Object.entries(row)) {
            if (cell !== undefined && cellJsonBytes(cell) > MAX_CELL_JSON_BYTES) {
              dropped = true;
              this.#oversized.set(JSON.stringify([tableId, rowId, cellId]), typeof cell);
              continue;
            }
            guardedRow[cellId] = cell;
          }
          guardedTable[rowId] = guardedRow;
        }
        guarded[tableId] = guardedTable;
      }
      return (dropped ? [guarded, values, marker] : [tables, values, marker]) as Changes;
    });

    // Flush the corrective rewrites as a fresh top-level transaction. A write
    // made from inside a transaction listener is discarded, so the flush is
    // deferred to a microtask — convergence is eventual, which is the right
    // shape for a CRDT anyway.
    this.store.addDidFinishTransactionListener(() => {
      if (this.#oversized.size === 0 || this.#flushing) return;
      this.#flushing = true;
      queueMicrotask(() => this.flushOversized());
    });
  }

  // Rewrite every cell the merge guard stripped. The stripped merge only edited
  // the plain store; this write carries the store's own newer HLC, so it
  // converges the oversized value away in the stamp tree — which is what the
  // persister, the export, and every replica actually read.
  flushOversized(): void {
    const pending = [...this.#oversized];
    this.#oversized.clear();
    try {
      this.store.transaction(() => {
        for (const [coord, cellType] of pending) {
          const [tableId, rowId, cellId] = JSON.parse(coord) as [string, string, string];
          // Must be schema-valid for the cell (arrays report typeof 'object';
          // a string write to an array-typed cell is rejected and stamps
          // nothing) AND differ from the value the stripped merge left behind:
          // a write equal to the current value is a no-op producing no stamp —
          // either way the blob would stay in the stamp tree. The marker also
          // leaves a visible receipt.
          const sentinel: Cell =
            cellType === 'number' ? 0
            : cellType === 'boolean' ? false
            : cellType === 'object' ? ([DROPPED_MARKER] as unknown as Cell)
            : DROPPED_MARKER;
          if (JSON.stringify(this.store.getCell(tableId, rowId, cellId)) === JSON.stringify(sentinel)) {
            // A prior drop already left the sentinel here; writing it again
            // would be stampless. Deleting is a change, so it stamps — and the
            // next drop can write the sentinel again.
            this.store.delCell(tableId, rowId, cellId);
          } else {
            this.store.setCell(tableId, rowId, cellId, sentinel);
          }
        }
      });
    } finally {
      this.#flushing = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/export') {
      return Response.json(this.exportContent());
    }
    // WebSocket sync path — WsServerDurableObject implements fetch at runtime,
    // but types it as the optional DurableObject.fetch, so guard the call.
    //
    // The router (index.ts) has already verified this request is authorized
    // (the gate vouched for a lease, a spent ticket, or — until the sunset —
    // a legacy session) and states the result in `X-Sync-Auth`. The DO trusts
    // that header and stores only the handles from it.
    const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (!isUpgrade) {
      return (await super.fetch?.(request)) ?? new Response('Expected WebSocket', { status: 426 });
    }

    // Fail closed on the way in. An upgrade with no usable handoff is a socket
    // the DO could never re-auth — it would hold the store open forever on the
    // strength of a check nobody can repeat. Refusing before super.fetch()
    // means no socket is accepted at all, rather than one accepted and then
    // left un-introspectable.
    const attachment = readSyncAuth(request);
    if (attachment === null) return new Response('Unauthorized', { status: 401 });

    const clientId = request.headers.get('sec-websocket-key');
    const response = (await super.fetch?.(request)) ?? new Response('Expected WebSocket', { status: 426 });
    if (clientId) {
      const [ws] = this.ctx.getWebSockets(clientId);
      if (ws) {
        ws.serializeAttachment(attachment);
        // Arm the sweep on this, the first successful attach that finds no
        // alarm already pending — idempotent, so a second connection never
        // pushes a live sweep further out.
        await this.#armAlarm();
      }
    }
    return response;
  }

  async #armAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }

  // Re-auth on traffic, not on a timer: a socket that has gone quiet for >5
  // minutes of activity gets re-introspected before its next message is
  // processed — and by handle, since the attachment holds no bearer to
  // present. The gate's answer maps to exactly one verdict:
  //
  //   throw (unreachable, 401 config error, 5xx)  -> 4002, never 4001: a
  //       governor blip must never read as revocation. Same failure shape as
  //       a brand-new connection refused when the gate can't be reached.
  //   active:false                                -> 4001, terminal — unless
  //       `inactiveClose` reads it as an aged token (see there).
  //   active:false + reason 'token-expired', or an exchange attachment whose
  //       own access-token `exp` has passed        -> 4004: the lease lives,
  //       the minting access token aged out. The browser re-exchanges its
  //       Pocket ID session and comes back; nothing was revoked.
  //   active, but scope or ownership lost         -> 4003.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (attachment && Date.now() - attachment.verifiedAt > REAUTH_INTERVAL_MS) {
      const form = handleForm(attachment);
      if (form === null) {
        // Unanswerable, not refused — see handleForm.
        ws.close(CLOSE_INDEFINITE, INDEFINITE_MSG);
        return;
      }
      let introspection;
      try {
        // Through the GATE service binding, never a public URL (issue #28).
        introspection = await introspectByHandle(form, this.env.GATE, this.env.INTROSPECT_SECRET);
      } catch {
        ws.close(CLOSE_INDEFINITE, INDEFINITE_MSG);
        return;
      }
      if (!introspection.active) {
        const { code, message } = inactiveClose(attachment, introspection.reason, Date.now());
        ws.close(code, message);
        return;
      }
      // Defense in depth: even though the router already refused a
      // non-socket-capable scope (and a non-owning principal) at upgrade time,
      // re-check both here on every traffic-driven re-auth so a socket that
      // predates a scope downgrade or an ownership change (or any router
      // bug) is independently closed rather than trusted indefinitely. A
      // scope- or ownership-lost close is neither a revocation (4001) nor an
      // unavailable governor (4002) — it gets its own code.
      // Production sockets always carry [clientId, pathId] tags (tinybase's
      // WsServerDurableObject tags them at accept in fetch(); webSocketClose
      // reads both tags) — an owner-less socket means path identity is
      // unavailable, and that must fail closed rather than let an absent
      // owner accidentally equal an absent principal.
      const pathId = this.getPathId();
      const ownerAvailable = pathId !== undefined && pathId !== '';
      const owner = ownerAvailable ? pathId.split('/')[0] : '';
      const scopeOk = SOCKET_SCOPES.has(introspection.scope ?? '');
      const ownerOk = ownerAvailable && (introspection.principal ?? '') === owner;
      if (!scopeOk || !ownerOk) {
        const detail = !scopeOk
          ? `refused: scope ${introspection.scope} may not hold a socket`
          : !ownerAvailable
          ? 'refused: store identity unavailable for socket re-auth'
          : `refused: principal ${introspection.principal} does not own ${owner}`;
        const reason = !scopeOk
          ? SOCKET_REQUIRED_MSG
          : !ownerAvailable
          ? 'store identity unavailable'
          : 'lease does not own this store';
        void this.env.GATE.fetch('https://gate/refusals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Introspect-Secret': this.env.INTROSPECT_SECRET },
          body: JSON.stringify({
            lease_id: introspection.leaseId ?? attachment.leaseId,
            door_name: introspection.doorName ?? '',
            service: 'stream', verb: 'socket', detail,
          }),
        }).catch(() => undefined);
        ws.close(CLOSE_SCOPE_LOST, reason);
        return;
      }
      // A fresh verdict re-stamps the clock and clears the sweep's patience:
      // the socket has just proven itself, so the alarm sweep starts counting
      // indefinite answers again from zero.
      ws.serializeAttachment({
        ...attachment, verifiedAt: Date.now(), indefiniteSweeps: 0,
      } satisfies SocketAttachment);
    }
    // WsServerDurableObject implements webSocketMessage at runtime, but types
    // it as the optional DurableObject.webSocketMessage, so guard the call.
    return super.webSocketMessage?.(ws, message);
  }

  // WsServerDurableObject's own webSocketClose does the TinyBase client
  // bookkeeping (onClientId/onPathId — what keeps getPathId/getClientIds
  // correct for the next accept or sweep) — call it first, unconditionally,
  // before this override decides anything about the alarm. `ws` is filtered
  // out of the "any sockets left?" check explicitly rather than trusting
  // ctx.getWebSockets() to have already dropped it by the time this runs.
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await super.webSocketClose?.(ws, code, reason, wasClean);
    const remaining = this.ctx.getWebSockets().filter((socket) => socket !== ws);
    if (remaining.length === 0) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // The alarm sweep: the wall-clock backstop above (SEC NEW-5, OPS N-7,
  // COLD M-10). Every attached socket is validated unconditionally, every
  // sweep — sweeping only stale-verifiedAt sockets would lose the bound,
  // since a chatty socket re-stamps verifiedAt from the (still-cached)
  // message-driven path without ever proving itself against a bypassed one.
  async alarm(): Promise<void> {
    // Snapshot BEFORE closing anything: getPathId() reads the tags of
    // whichever socket happens to be first in ctx.getWebSockets() right
    // now (see the base implementation) — closing sockets in a loop can
    // empty or reorder that list mid-sweep and mislabel a survivor's
    // ownership check.
    const pathId = this.getPathId();
    const ownerAvailable = pathId !== undefined && pathId !== '';
    const owner = ownerAvailable ? pathId.split('/')[0] : '';

    const entries: { ws: WebSocket; attachment: SocketAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (attachment) entries.push({ ws, attachment });
    }

    // One introspection per distinct identity per sweep, not one per
    // socket: the GovernorDO is a singleton serving every other verb, and a
    // fleet of sockets sharing one lease must not turn into a fleet of
    // requests every 5 minutes.
    const groups = new Map<string, { ws: WebSocket; attachment: SocketAttachment }[]>();
    for (const entry of entries) {
      const key = `${entry.attachment.leaseId}:${entry.attachment.tokenId ?? entry.attachment.subject ?? ''}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    const now = Date.now();

    // A gate blip (or an attachment the DO can never form a question for —
    // see handleForm) must not read as revocation: it leaves every socket
    // in the group attached, counting strikes, and only closes once three
    // consecutive sweeps have failed to get a definitive answer.
    const closeIndefinite = (group: { ws: WebSocket; attachment: SocketAttachment }[]): void => {
      for (const { ws, attachment } of group) {
        const strikes = attachment.indefiniteSweeps + 1;
        if (strikes >= SWEEP_INDEFINITE_STRIKES) {
          ws.close(CLOSE_INDEFINITE, SWEEP_INDEFINITE_MSG);
        } else {
          ws.serializeAttachment({ ...attachment, indefiniteSweeps: strikes } satisfies SocketAttachment);
        }
      }
    };

    for (const group of groups.values()) {
      const sample = group[0].attachment;
      const form = handleForm(sample);
      if (form === null) {
        closeIndefinite(group);
        continue;
      }
      let introspection: LeaseIntrospection;
      try {
        // Bypasses the 60s cache on purpose — the sweep's whole job is to
        // distrust a warm answer.
        introspection = await introspectByHandle(
          form, this.env.GATE, this.env.INTROSPECT_SECRET, { bypassCache: true },
        );
      } catch {
        closeIndefinite(group);
        continue;
      }

      if (!introspection.active) {
        for (const { ws, attachment } of group) {
          const { code, message } = inactiveClose(attachment, introspection.reason, now);
          ws.close(code, message);
        }
        continue;
      }

      // Active: defense in depth, same as the message-driven path — a
      // scope downgrade or an ownership change independently closes the
      // socket rather than leaving it trusted until it next speaks.
      const scopeOk = SOCKET_SCOPES.has(introspection.scope ?? '');
      const ownerOk = ownerAvailable && (introspection.principal ?? '') === owner;
      if (!scopeOk || !ownerOk) {
        const detail = !scopeOk
          ? `refused: scope ${introspection.scope} may not hold a socket`
          : !ownerAvailable
          ? 'refused: store identity unavailable for socket re-auth'
          : `refused: principal ${introspection.principal} does not own ${owner}`;
        const reason = !scopeOk
          ? SOCKET_REQUIRED_MSG
          : !ownerAvailable
          ? 'store identity unavailable'
          : 'lease does not own this store';
        for (const { ws, attachment } of group) {
          void this.env.GATE.fetch('https://gate/refusals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Introspect-Secret': this.env.INTROSPECT_SECRET },
            body: JSON.stringify({
              lease_id: introspection.leaseId ?? attachment.leaseId,
              door_name: introspection.doorName ?? '',
              service: 'stream', verb: 'socket', detail,
            }),
          }).catch(() => undefined);
          ws.close(CLOSE_SCOPE_LOST, reason);
        }
        continue;
      }

      // Healthy: the sweep's own verdict re-stamps the clock and clears
      // the strike count, same as a successful message-driven re-auth.
      for (const { ws, attachment } of group) {
        ws.serializeAttachment({ ...attachment, verifiedAt: now, indefiniteSweeps: 0 } satisfies SocketAttachment);
      }
    }

    // Re-arm while any socket remains — including ones that were just
    // reset above — and stay silent (no re-arm) once the sweep has closed
    // the last of them; webSocketClose is the other place this alarm gets
    // cancelled, for the ordinary path of a socket leaving on its own.
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }

  exportContent(): ExportedContent {
    const mergeableContent = this.store.getMergeableContent();
    return {
      mergeableContent,
      contentHash: getHash(JSON.stringify(mergeableContent)),
      ledgerId: (this.store.getValue('ledgerId') as string | undefined) ?? null,
      exportedAt: new Date().toISOString(),
    };
  }
}
