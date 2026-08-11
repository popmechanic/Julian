// The consolidated scope-invariant suite (plan Task 7, authored here as a file
// because a "gate" writes none). Each invariant that keeps the MCP visit from
// ever holding more than a reading key is asserted against the integrated tree.
// These properties are already individually covered by the green per-face
// suites; this file states them together so a regression on any one is caught
// as a named invariant, not only as an incidental failure elsewhere.
//
// Testing seam (same as approve.test.ts / lease-auth.test.ts): wrangler [vars]
// do not propagate through `SELF`, so HTTP-level invariants call
// `handleAuthcode(req, env, gov, registrar)` directly with a hand-built Env and
// scripted GOVERNOR/REGISTRAR stubs, and DO-level invariants run inside the real
// Durable Object via `runInDurableObject`.
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import { handleAuthcode, PENDING_COOKIE } from '../src/as/authcode';
import { scopeAllows } from '../src/lease-auth';
import type { Env } from '../src/env';
import type { GovernorDO, MintResult } from '../src/governor';
import type { RegistrarDO } from '../src/registrar';

const BASE = 'https://gate.test';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function gov(name: string) {
  return env.GOVERNOR.get(env.GOVERNOR.idFromName(name)) as unknown as DurableObjectStub<GovernorDO>;
}
function reg(name: string) {
  return env.REGISTRAR.get(env.REGISTRAR.idFromName(name)) as unknown as DurableObjectStub<RegistrarDO>;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── the scripted HTTP harness (for the /register and /authorize invariants) ──

interface Calls {
  register: Array<Record<string, unknown>>;
  createPending: Array<Record<string, unknown>>;
  redeem: Array<Record<string, unknown>>;
  mint: Array<[string, string, string, string]>;
}

/** A GOVERNOR stub that enforces the real server-side AUTHCODE_SCOPES gate. */
function govStub(calls: Calls): DurableObjectStub<GovernorDO> {
  const AUTHCODE_SCOPES = ['reading-room', 'stream-read'];
  return {
    async mintAuthcodeLease(
      doorName: string, scope: string, principal: string, claims: string,
    ): Promise<MintResult> {
      calls.mint.push([doorName, scope, principal, claims]);
      if (!AUTHCODE_SCOPES.includes(scope)) return { status: 'invalid' };
      return { status: 'ok', accessToken: 'jla_access', refreshToken: 'jlr_refresh', expiresIn: 900, scope };
    },
  } as unknown as DurableObjectStub<GovernorDO>;
}

function registrarStub(calls: Calls): DurableObjectStub<RegistrarDO> {
  return {
    async registerClient(meta: Record<string, unknown>) {
      calls.register.push(meta);
      if (meta.token_endpoint_auth_method !== 'none') {
        return { error: 'invalid_client_metadata: only public clients' };
      }
      return { client_id: 'client-abc' };
    },
    async createPending(p: Record<string, unknown>) {
      calls.createPending.push(p);
      return { pendingId: 'pending-xyz' };
    },
    async redeem(p: Record<string, unknown>) {
      calls.redeem.push(p);
      return { elected_scope: 'reading-room', door_name: 'visit:claude.ai' };
    },
  } as unknown as DurableObjectStub<RegistrarDO>;
}

function harness() {
  const calls: Calls = { register: [], createPending: [], redeem: [], mint: [] };
  const gateEnv = { PUBLIC_URL: BASE, MCP_RESOURCE_URL: RESOURCE } as unknown as Env;
  return { calls, env: gateEnv, gov: govStub(calls), registrar: registrarStub(calls) };
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
function setCookieNames(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const all = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
    ?? (res.headers.get('Set-Cookie') ? [res.headers.get('Set-Cookie') as string] : []);
  for (const raw of all) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}
const HAPPY_AUTHORIZE = {
  response_type: 'code', client_id: 'client-abc', redirect_uri: REDIRECT,
  code_challenge: 'a-challenge', code_challenge_method: 'S256', resource: RESOURCE,
};

// ── Invariant 1: the authcode mint can never produce a full-house lease ──────

describe('invariant 1 — the authcode mint path cannot produce full-house for any input', () => {
  test('the DO-level AUTHCODE_SCOPES gate refuses full-house (and any non-authcode scope), mints nothing', async () => {
    await runInDurableObject(gov('inv1-gate'), async (i: GovernorDO) => {
      for (const scope of ['full-house', 'nonsense', '', '__proto__', 'constructor']) {
        const r = await i.mintAuthcodeLease('visit:claude.ai', scope, 'julian', '{}');
        expect(r.status, scope).toBe('invalid');
      }
      // no lease of any of those refused scopes was ever written
      expect(i.leaseList().some((l) => l.doorName === 'visit:claude.ai')).toBe(false);
      // and the only scopes it accepts are the two reading scopes
      for (const scope of ['reading-room', 'stream-read']) {
        expect((await i.mintAuthcodeLease(`visit:${scope}`, scope, 'julian', '{}')).status, scope).toBe('ok');
      }
      // no authcode-flow lease is ever full-house (the seeded legacy-window
      // pseudo-lease is device-flow and outside this invariant).
      expect(i.leaseList().some((l) => l.flow === 'authcode' && l.scope === 'full-house')).toBe(false);
      expect(i.leaseList().filter((l) => l.flow === 'authcode').map((l) => l.scope).sort())
        .toEqual(['reading-room', 'stream-read']);
    });
  });
});

// ── Invariant 2: reading-room grants package reads only ──────────────────────

describe('invariant 2 — a reading-room lease allows only package.list/package.read', () => {
  test('scopeAllows grants the two package reads and refuses every stream.* and mail.* verb', () => {
    expect(scopeAllows('reading-room', 'package', 'list')).toBe(true);
    expect(scopeAllows('reading-room', 'package', 'read')).toBe(true);
    for (const [service, verb] of [
      ['stream', 'recent'], ['stream', 'session'], ['stream', 'search'],
      ['mail', 'read'], ['mail', 'list'], ['mail', 'send'],
    ] as Array<[string, string]>) {
      expect(scopeAllows('reading-room', service, verb), `${service}.${verb}`).toBe(false);
    }
  });
});

// ── Invariant 3: DCR is public-only, and registration alone mints no lease ────

describe('invariant 3 — DCR rejects a confidential client and registration mints no lease', () => {
  test('a confidential client is 400 and no lease is minted', async () => {
    const h = harness();
    const req = new Request(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' }),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(h.calls.mint).toEqual([]);
  });

  test('a successful public registration mints no lease on its own — it only records the client', async () => {
    const h = harness();
    const req = new Request(`${BASE}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    const res = await handleAuthcode(req, h.env, h.gov, h.registrar);
    expect(res.status).toBe(201);
    expect(h.calls.mint).toEqual([]);
    expect(h.calls.createPending).toEqual([]);
  });
});

// ── Invariant 4: /authorize refuses plain PKCE and a wrong/absent resource ───

describe('invariant 4 — /authorize refuses a plain challenge and a wrong/absent RFC 8707 resource', () => {
  test('a plain code_challenge_method is 400 with no pending and no mint', async () => {
    const h = harness();
    const res = await handleAuthcode(
      new Request(authorizeUrl({ ...HAPPY_AUTHORIZE, code_challenge_method: 'plain' })),
      h.env, h.gov, h.registrar,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBe(null);
    expect(setCookieNames(res)[PENDING_COOKIE]).toBeUndefined();
    expect(h.calls.createPending).toEqual([]);
    expect(h.calls.mint).toEqual([]);
  });

  test('a wrong resource is 400 with no pending', async () => {
    const h = harness();
    const res = await handleAuthcode(
      new Request(authorizeUrl({ ...HAPPY_AUTHORIZE, resource: 'https://evil.test/mcp' })),
      h.env, h.gov, h.registrar,
    );
    expect(res.status).toBe(400);
    expect(h.calls.createPending).toEqual([]);
  });

  test('an absent resource is 400 with no pending', async () => {
    const h = harness();
    const params = { ...HAPPY_AUTHORIZE } as Record<string, string>;
    delete params.resource;
    const res = await handleAuthcode(new Request(authorizeUrl(params)), h.env, h.gov, h.registrar);
    expect(res.status).toBe(400);
    expect(h.calls.createPending).toEqual([]);
  });
});

// ── Invariant 5: an authcode is single-use, and a forged pending id is inert ──

describe('invariant 5 — a redeemed authcode is single-use and a forged pending id cannot be approved', () => {
  test('a full round-trip redeems once; a second redeem fails; a forged pending id never approves', async () => {
    await runInDurableObject(reg('inv5'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'z'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: REDIRECT,
        code_challenge: challenge, resource: RESOURCE, ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;

      // a pending id the approver's cookie does not name can never be approved
      expect(await i.attachApproval('forged-pending-id', 'user_marcus', 'reading-room')).toBe(false);

      expect(await i.attachApproval(pendingId, 'user_marcus', 'reading-room')).toBe(true);
      const first = await i.redeem({
        code: pendingId, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
      });
      expect(first).toMatchObject({ elected_scope: 'reading-room' });
      const second = await i.redeem({
        code: pendingId, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
      });
      expect('error' in second).toBe(true);
    });
  });
});

// ── Invariant 6: the device flow is untouched — still device, still full-house ─

describe('invariant 6 — the device flow still mints flow=device and can be granted full-house', () => {
  test('a device knock approved for full-house mints a living device lease (regression)', async () => {
    await runInDurableObject(gov('inv6'), async (i: GovernorDO) => {
      const knock = await i.knockCreate('aurora-vm', 'aurora.exe.xyz', 'send mail from the VM door');
      if ('error' in knock) throw new Error('knock refused');
      expect(i.knockDecide(knock.userCode, 'approved', 'door:aurora-vm', 'full-house')).toBe(true);
      const ready = await i.devicePoll(knock.deviceCode, 'aurora-vm');
      expect(ready.status).toBe('ready');
      const row = i.leaseList().find((l) => l.doorName === 'door:aurora-vm');
      expect(row?.flow).toBe('device');
      expect(row?.scope).toBe('full-house');
    });
  });
});
