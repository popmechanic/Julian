// sync/src/do.ts — JulianSyncDO: schema'd store, v9 fragmented SQLite persister,
// cell-size guard, and the witnessed export path (dream 0006, constraint 2).
import { WsServerDurableObject } from 'tinybase/synchronizers/synchronizer-ws-server-durable-object';
import { createDurableObjectSqlStoragePersister } from 'tinybase/persisters/persister-durable-object-sql-storage';
import { createMiddleware, getHash } from 'tinybase';
import type { Middleware, Cell, Changes, Value } from 'tinybase';
import type { MergeableStore } from 'tinybase/mergeable-store';
import { createStreamStore } from 'julian-shared/schema';
import { encodeUndefined, decodeUndefined } from 'julian-shared/export-codec';
import {
  SYNC_AUTH_HEADER,
  type InternalReadRequest,
  type SyncAuthPayload,
} from 'julian-shared/gate-contract';
import { SOCKET_REQUIRED_MSG, SOCKET_SCOPES } from 'julian-shared/scopes';
import { introspectByHandle, type Env, type LeaseIntrospection } from './auth';
import { readRecent, readSearch, readSession, type ReadResult } from './reads';

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

// The creation ceremony's identity values (scripts/lib/creation.ts): once
// set, no socket may ever change them — the once-ever guard, server-side (#9).
// activeSessionId is runtime state and deliberately absent, as is
// storeSchemaVersion, which a migration is allowed to advance.
export const LINEAGE_KEYS = [
  'ledgerId', 'parentLedgerId', 'lineageNote', 'createdAt', 'createdBy',
] as const;
const LINEAGE_KEY_SET: ReadonlySet<string> = new Set<string>(LINEAGE_KEYS);

// The transient value the restore bounce writes before rewriting the true one.
// It is only ever visible for the width of one microtask, but if a replica
// happens to observe it, it should say what it is — not borrow the oversized
// guard's sentence, which would claim a size problem that never happened.
const LINEAGE_RESTORE_MARKER = '[lineage-restore: refused an overwrite of an immutable lineage value]';
// createdAt is schema-typed 'number': a string temp would be rejected by the
// schema, stamp nothing, and leave the foreign value winning the stamp tree.
const LINEAGE_RESTORE_NUMBER = -1;

const ENCODER = new TextEncoder();
const cellJsonBytes = (cell: Cell): number => ENCODER.encode(JSON.stringify(cell ?? '')).length;

// The DO-side path the router rewrites an internal read onto. Deliberately
// not the public prefix: by the time a request reaches here the `/internal/`
// reservation has done its work, and the DO's own namespace is flat.
const READ_PREFIX = '/read/';

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
  // Captured in createPersister for the same reason, and under the same
  // discipline, as `store`: never a field initializer. The restore road is the
  // one write path that must be durable before it answers (see
  // restoreContent) — every other write is a socket merge, whose durability is
  // the auto-persister's ordinary business.
  persister!: ReturnType<typeof createDurableObjectSqlStoragePersister>;
  #middleware?: Middleware;
  // Cells stripped by the merge guard, awaiting an authoritative rewrite:
  // "<tableId> <rowId> <cellId>" -> the incoming cell's typeof.
  #oversized = new Map<string, string>();
  // Lineage overwrites blocked mid-merge: valueId → the true value to converge
  // back into the stamp tree (the incoming value already merged there before
  // the callback ran, same as the oversized cells).
  #lineageBlocked = new Map<string, Value>();
  #flushing = false;
  // Set only around the restore bounce below, so the local-path lineage guard
  // lets the DO's own corrective writes through. Nothing else may set it.
  #restoring = false;

  createPersister() {
    this.store = createStreamStore();
    // Guards are NOT installed here, deliberately. tinybase 9.2.0's
    // createMiddleware permanently breaks setMergeableContent's
    // stamp-faithfulness for array-typed cells (`messages.content`) — once a
    // store has ever been wrapped, a restore or persister load rewrites every
    // stamp as a fresh local write, flattening the record's provenance
    // (found live at R9 of the soul.store migration; destroy() does not undo
    // the wrap). So the store stays unwrapped through construction and the
    // persister's load, and ensureGuards() wraps it at the first surface
    // where live merge traffic can reach the store: a socket upgrade, a
    // hibernated socket's message, or the end of a restore.
    // v9 fragmented mode = row-level SQLite layout (avoids Cloudflare's 2 MB row
    // limit). Never downgrade tinybase below 9 — the on-disk layout is breaking.
    this.persister = createDurableObjectSqlStoragePersister(this.store, this.ctx.storage.sql, {
      mode: 'fragmented',
    });
    return this.persister;
  }

  // Match the client fragment size so large payloads never exceed the WS cap.
  getFragmentSize(): number {
    return FRAGMENT_SIZE;
  }

  // True once installGuards has wrapped the store. Wrapping is one-way in
  // tinybase 9.2.0 (see createPersister), so this flag is the only thing
  // standing between the store and a double wrap.
  #guardsInstalled = false;

  ensureGuards() {
    if (this.#guardsInstalled) return;
    this.#guardsInstalled = true;
    this.installGuards();
  }

  installGuards() {
    // Middleware (TinyBase v8+): reject any single cell whose JSON exceeds the
    // byte cap. Returning undefined from the callback rejects the write, leaving
    // the prior cell value intact.
    this.#middleware = createMiddleware(this.store);
    this.#middleware.addWillSetCellCallback((_tableId, _rowId, _cellId, cell) =>
      cellJsonBytes(cell) <= MAX_CELL_JSON_BYTES ? cell : undefined,
    );
    // The local write path's half of the lineage guard (#9). setValue and
    // setValues both funnel through here, so one callback covers both.
    // Returning undefined rejects the write and leaves the prior value intact.
    this.#middleware.addWillSetValueCallback((valueId, value) => {
      if (this.#restoring) return value; // the DO's own corrective rewrite
      if (!LINEAGE_KEY_SET.has(valueId)) return value;
      const existing = this.store.getValue(valueId);
      // First set (the creation ceremony) and an equal re-write both pass;
      // once set to something, lineage is immutable.
      if (existing === undefined || existing === value) return value;
      return undefined;
    });
    // Deletion is an overwrite by another name, and the most dangerous one:
    // once a lineage value is gone, `existing === undefined` makes the very
    // next write look like a first set, so an unguarded delete launders any
    // overwrite into two legal steps. Refuse both the single delete and the
    // wholesale one (delValues would take lineage with it).
    this.#middleware.addWillDelValueCallback((valueId) =>
      this.#restoring ||
      !LINEAGE_KEY_SET.has(valueId) ||
      this.store.getValue(valueId) === undefined,
    );
    this.#middleware.addWillDelValuesCallback(() =>
      this.#restoring ||
      !LINEAGE_KEYS.some((key) => this.store.getValue(key) !== undefined),
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
      // The same treatment for lineage values (#9). Strip the overwrite so the
      // plain store keeps the true value, and record it for the corrective
      // rewrite — the incoming value has already merged into the stamp tree,
      // which is the surface every replica actually reads.
      let guardedValues = values;
      if (values) {
        for (const key of LINEAGE_KEYS) {
          if (!(key in (values as Record<string, unknown>))) continue;
          const incoming = (values as Record<string, Value | undefined>)[key];
          const existing = this.store.getValue(key);
          // A present-but-undefined entry is a deletion, and it is refused for
          // the same reason as on the local path: it would launder the next
          // overwrite into a first set.
          if (existing === undefined || existing === incoming) continue;
          if (guardedValues === values) {
            guardedValues = { ...(values as Record<string, Value>) } as typeof values;
          }
          delete (guardedValues as Record<string, Value>)[key];
          this.#lineageBlocked.set(key, existing);
        }
      }
      return [dropped ? guarded : tables, guardedValues, marker] as Changes;
    });

    // Flush the corrective rewrites as a fresh top-level transaction. A write
    // made from inside a transaction listener is discarded, so the flush is
    // deferred to a microtask — convergence is eventual, which is the right
    // shape for a CRDT anyway.
    this.store.addDidFinishTransactionListener(() => {
      if ((this.#oversized.size === 0 && this.#lineageBlocked.size === 0) || this.#flushing) return;
      this.#flushing = true;
      queueMicrotask(() => this.flushGuarded());
    });
  }

  // The deferred corrective pass for both guards. Each half clears its own
  // pending map before writing, so the transactions below re-enter the
  // did-finish listener harmlessly.
  flushGuarded(): void {
    try {
      this.flushOversized();
      this.flushLineageBlocked();
    } finally {
      this.#flushing = false;
    }
  }

  // Rewrite every cell the merge guard stripped. The stripped merge only edited
  // the plain store; this write carries the store's own newer HLC, so it
  // converges the oversized value away in the stamp tree — which is what the
  // persister, the export, and every replica actually read.
  flushOversized(): void {
    const pending = [...this.#oversized];
    if (pending.length === 0) return;
    this.#oversized.clear();
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
  }

  // Converge a blocked lineage overwrite away. The strip only protected the
  // plain store; the foreign value already merged into the stamp tree. A
  // single restore write would be a stampless no-op (it equals the plain
  // store's current value), so bounce: write a temp, then the true value —
  // two stamps, the second newest, every replica converges back (#9).
  //
  // The bounce writes are the DO's own authority, not a socket's, so the
  // local-path guard is lifted around them; the flag is cleared in a finally
  // so a schema rejection can never leave lineage writable.
  flushLineageBlocked(): void {
    const pending = [...this.#lineageBlocked];
    if (pending.length === 0) return;
    this.#lineageBlocked.clear();
    this.#restoring = true;
    try {
      for (const [key, trueValue] of pending) {
        const temp: Value =
          typeof trueValue === 'number' ? LINEAGE_RESTORE_NUMBER : LINEAGE_RESTORE_MARKER;
        this.store.transaction(() => {
          this.store.setValue(key as never, temp as never);
        });
        this.store.transaction(() => {
          this.store.setValue(key as never, trueValue as never);
        });
      }
    } finally {
      this.#restoring = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/export') {
      return Response.json(this.exportContent());
    }
    if (request.method === 'POST' && url.pathname === '/restore') {
      return this.restoreContent(request);
    }
    // The internal read road's DO end. Only the router reaches this path, and
    // only after the read secret matched — the DO does no authentication of
    // its own here, exactly as it does none on the socket handoff. What it
    // does own is the store: the read verbs are pure functions over it
    // (src/reads.ts), and the DO is simply the place the store lives.
    if (url.pathname.startsWith(READ_PREFIX)) {
      return this.readVerb(request, url.pathname.slice(READ_PREFIX.length));
    }
    // WebSocket sync path — WsServerDurableObject implements fetch at runtime,
    // but types it as the optional DurableObject.fetch, so guard the call.
    //
    // The router (index.ts) has already verified this request is authorized
    // (the gate vouched for a lease, a spent ticket, or — until the sunset —
    // a legacy session) and states the result in `X-Sync-Auth`. The DO trusts
    // that header and stores only the handles from it.
    const isUpgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    // Live merge traffic starts here — wrap the store before any socket can
    // write to it (guards install lazily; see createPersister). Hibernated
    // sockets that wake without a fetch are covered by webSocketMessage below.
    this.ensureGuards();
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

  /**
   * `POST /read/{recent|session|search}` — Task 13's pure verbs over this
   * store, in the `InternalReadResponse` shape the broker reads.
   *
   * A read never mutates and never throws a partial answer: an empty store is
   * `{ok:true, rows:[], truncated:false}`, which the caller renders as "the
   * stream is quiet" rather than as a failure.
   */
  async readVerb(request: Request, kind: string): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('reads are POST', { status: 405 });
    }
    let body: InternalReadRequest;
    try {
      body = await request.json() as InternalReadRequest;
    } catch {
      return new Response('unreadable body', { status: 400 });
    }
    let result: ReadResult;
    if (kind === 'recent') {
      result = readRecent(this.store, body?.limit);
    } else if (kind === 'session') {
      result = readSession(this.store, body?.sessionId ?? '', { from: body?.from, to: body?.to });
    } else if (kind === 'search') {
      result = readSearch(this.store, body?.query ?? '', body?.limit);
    } else {
      return new Response('no such read verb', { status: 404 });
    }
    return Response.json({ ok: true, rows: result.rows, truncated: result.truncated });
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
    // A hibernated socket wakes the DO without passing through fetch, so this
    // is a first-write surface of its own — the guards must wrap the store
    // before the synchronizer sees the message (lazy install; createPersister).
    this.ensureGuards();
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

  // One-shot restore (soul.store migration): applies a decoded export into an
  // EMPTY store only, preserving every CRDT stamp, and answers with the
  // freshly recomputed export hash so the caller can prove hash-equality
  // against the source. A non-empty store is a 409 — this road can never
  // clobber a living record.
  async restoreContent(request: Request): Promise<Response> {
    // Emptiness is read off the STAMP TREE, not the plain store. Two reasons,
    // and the first is load-bearing: the values schema gives `activeSessionId`
    // a default, so `getValueIds()` on a never-written store already answers
    // `['activeSessionId']` — a plain-store check would 409 every restore,
    // forever, and the road would be dead on arrival. The second: a store
    // whose only content is a retraction (a deletion stamp) has an empty
    // plain view but is emphatically a written record, and must not be
    // overwritten. The stamp tree is exactly "has anything ever been written
    // here", which is the question this guard is asking.
    const [[tables], [values]] = this.store.getMergeableContent();
    const empty = Object.keys(tables).length === 0 && Object.keys(values).length === 0;
    if (!empty) {
      return Response.json({ error: 'store is not empty — restore is one-shot' }, { status: 409 });
    }
    let body: { mergeableContent?: unknown };
    try {
      body = await request.json() as { mergeableContent?: unknown };
    } catch {
      return Response.json({ error: 'unreadable body — send {"mergeableContent": ...}' }, { status: 400 });
    }
    if (body?.mergeableContent === undefined) {
      return Response.json({ error: 'body must carry mergeableContent' }, { status: 400 });
    }
    // If live traffic has already wrapped the store, a stamp-faithful restore
    // is impossible (the wrap is one-way — see createPersister) and the store
    // is in practice non-empty anyway. The emptiness 409 above will almost
    // always answer first; this check makes the impossibility explicit rather
    // than letting a wrapped store silently flatten the archive's provenance.
    if (this.#guardsInstalled) {
      return Response.json(
        { error: 'store has already served live traffic — restore is one-shot' }, { status: 409 });
    }
    try {
      // The store is unwrapped here by construction (guards install lazily,
      // and the branch above refused a wrapped store), so this call adopts
      // every CRDT stamp verbatim — the whole point of the hash-equal proof.
      this.store.setMergeableContent(decodeUndefined(body.mergeableContent) as never);
    } catch (e) {
      // The error's CLASS, never its message: a thrown message from deep
      // inside the merge can quote the offending value, and the value here is
      // record content. The class names the failure without carrying any of
      // the stream across the wire.
      const kind = e instanceof Error ? e.name : typeof e;
      return Response.json(
        { error: `restore failed while merging content (${kind})` }, { status: 400 });
    } finally {
      // Restore is over either way; from here the store carries (or refused)
      // the record and every subsequent write is live traffic — guard it.
      this.ensureGuards();
    }
    try {
      // Durable before the 200. The auto-persister would otherwise flush on
      // its own schedule, i.e. AFTER the response — so the caller would be
      // told "restored" while the bytes were still only in memory, and a DO
      // eviction in that window would silently lose the whole migration. This
      // road runs exactly once against an empty store; it can afford to wait,
      // and the answer must mean what it says.
      await this.persister.save();
    } catch (e) {
      // A distinct class from the 400 above, in its own try: by this point the
      // merge has already landed in memory, so a 400 would blame the caller's
      // body and the natural retry would answer 409 — the one-shot road spent
      // on a storage fault reported as a merge error. 500 names the true
      // party; the caller verifies with /export before deciding anything.
      const kind = e instanceof Error ? e.name : typeof e;
      return Response.json(
        { error: `restore merged but durability failed (${kind}) — verify with export before any retry` },
        { status: 500 });
    }
    return Response.json({ restored: true, contentHash: this.exportContent().contentHash });
  }

  exportContent(): ExportedContent {
    // Issue #48: deleted cells are stamped undefined in the CRDT, and bare
    // JSON collapses undefined → null — a live-looking value that resurrects
    // the deletion on restore. Encode before serialization so the artifact is
    // lossless; consumers decode (julian-shared/export-codec) before
    // setMergeableContent. The hash covers the encoded form as served.
    const mergeableContent = encodeUndefined(this.store.getMergeableContent());
    return {
      mergeableContent,
      contentHash: getHash(JSON.stringify(mergeableContent)),
      ledgerId: (this.store.getValue('ledgerId') as string | undefined) ?? null,
      exportedAt: new Date().toISOString(),
    };
  }
}
