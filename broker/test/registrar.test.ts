import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test } from 'vitest';
import type { RegistrarDO } from '../src/index';

function reg(name: string) {
  return env.REGISTRAR.get(env.REGISTRAR.idFromName(name)) as unknown as DurableObjectStub<RegistrarDO>;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('RegistrarDO logic', () => {
  test('rejects a confidential client', async () => {
    await runInDurableObject(reg('t-conf'), async (i: RegistrarDO) => {
      const r = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'client_secret_post',
      });
      expect('error' in r).toBe(true);
    });
  });

  test('a full round-trip: register → pending → approve → redeem yields the elected scope', async () => {
    await runInDurableObject(reg('t-round'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      // S256 pair with a known verifier
      const verifier = 'a'.repeat(64);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://julian-broker.julian-memory.workers.dev/mcp',
        ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      expect(await i.attachApproval(pendingId, 'user_marcus', 'reading-room')).toBe(true);
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect(ok).toMatchObject({ elected_scope: 'reading-room' });
      // single-use: a second redeem fails
      const twice = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('error' in twice).toBe(true);
    });
  });

  test('redeem rejects a wrong PKCE verifier', async () => {
    await runInDurableObject(reg('t-pkce'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['http://localhost:3118/callback'], token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'http://localhost:9999/callback', // loopback, port ignored
        code_challenge: 'not-a-real-challenge', resource: 'https://julian-broker.julian-memory.workers.dev/mcp',
        ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const bad = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'http://localhost:9999/callback', code_verifier: 'wrong',
      });
      expect('error' in bad).toBe(true);
    });
  });

  test('registerClient rejects when no acceptable redirect_uri is present', async () => {
    await runInDurableObject(reg('t-badredir'), async (i: RegistrarDO) => {
      const r = await i.registerClient({
        redirect_uris: ['http://evil.example.com/callback'],
        token_endpoint_auth_method: 'none',
      });
      expect('error' in r).toBe(true);
    });
  });

  test('registerClient rejects an empty redirect_uris list', async () => {
    await runInDurableObject(reg('t-emptyredir'), async (i: RegistrarDO) => {
      const r = await i.registerClient({
        redirect_uris: [],
        token_endpoint_auth_method: 'none',
      });
      expect('error' in r).toBe(true);
    });
  });

  test('registerClient stores the decoded origin of the first redirect_uri', async () => {
    await runInDurableObject(reg('t-origin'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const challenge = await s256('b'.repeat(64));
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      const view = await i.pendingView(pendingId);
      expect(view).toMatchObject({
        client_id: clientId,
        origin: 'https://claude.ai',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      });
    });
  });

  test('createPending records the client state and pendingView returns it for the redirect', async () => {
    await runInDurableObject(reg('t-state'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const challenge = await s256('c'.repeat(64));
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', state: 'cli-state-42', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      const view = await i.pendingView(pendingId);
      expect(view).toMatchObject({ state: 'cli-state-42' });
    });
  });

  test('a createPending with no state yields an empty state, never a null', async () => {
    await runInDurableObject(reg('t-state-empty'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const challenge = await s256('d'.repeat(64));
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const view = await i.pendingView((pend as { pendingId: string }).pendingId);
      expect(view?.state).toBe('');
    });
  });

  test('createPending rejects a redirect_uri the client never registered', async () => {
    await runInDurableObject(reg('t-mismatch'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const r = await i.createPending({
        client_id: clientId, redirect_uri: 'https://evil.example.com/steal',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('error' in r).toBe(true);
    });
  });

  test('createPending rejects an unknown client', async () => {
    await runInDurableObject(reg('t-noclient'), async (i: RegistrarDO) => {
      const r = await i.createPending({
        client_id: 'ghost', redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('error' in r).toBe(true);
    });
  });

  test('attachApproval returns false for an unknown pendingId', async () => {
    await runInDurableObject(reg('t-noapprove'), async (i: RegistrarDO) => {
      expect(await i.attachApproval('nope', 'user_marcus', 'reading-room')).toBe(false);
    });
  });

  test('redeem refuses a code that was never approved', async () => {
    await runInDurableObject(reg('t-unapproved'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'c'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      // no attachApproval
      const r = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('error' in r).toBe(true);
    });
  });

  test('redeem refuses an expired code', async () => {
    await runInDurableObject(reg('t-expired'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'd'.repeat(64);
      const challenge = await s256(verifier);
      const base = Date.now();
      i.now = () => base;
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      i.now = () => base + 601_000; // past the 600s ttl
      const r = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('error' in r).toBe(true);
    });
  });

  test('redeem refuses a client_id / redirect_uri mismatch', async () => {
    await runInDurableObject(reg('t-redeemmismatch'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'e'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const wrongClient = await i.redeem({
        code: pendingId, client_id: 'someone-else',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('error' in wrongClient).toBe(true);
      const wrongRedirect = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/other', code_verifier: verifier,
      });
      expect('error' in wrongRedirect).toBe(true);
    });
  });

  test('redeem derives a stable door_name from the origin host', async () => {
    await runInDurableObject(reg('t-doorname'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'f'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'stream-read');
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect(ok).toEqual({ elected_scope: 'stream-read', door_name: 'visit:claude.ai' });
    });
  });

  // Task-6-of-B2 leftover (§10.3): redeem() burns the row with `used = 1`,
  // never a DELETE — the tombstone survives for audit. pendingView carries no
  // used-filter, so its continued non-null answer is the row's own proof of
  // survival, with no new test seam needed.
  test('redeem marks the code used, never deletes the row — the tombstone survives for audit', async () => {
    await runInDurableObject(reg('t-tombstone'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'c'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect(ok).toMatchObject({ elected_scope: 'reading-room' });
      // the row survives redemption — a DELETE would make this null
      const view = await i.pendingView(pendingId);
      expect(view).not.toBeNull();
      expect(view).toEqual({
        client_id: clientId, origin: 'https://claude.ai',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', state: '',
      });
    });
  });

  test('pendingView returns null for an unknown pendingId and never leaks the challenge', async () => {
    await runInDurableObject(reg('t-viewnull'), async (i: RegistrarDO) => {
      expect(await i.pendingView('ghost')).toBe(null);
    });
  });

  // DEFECT 1 (redirect-URI spoof): a mixed acceptable/unacceptable list must
  // store ONLY the acceptable entries, so the plain-http public redirect can
  // never be matched at createPending — proof it was never stored.
  test('a mixed list stores only acceptable redirects; the unacceptable one never matches', async () => {
    await runInDurableObject(reg('t-mixed'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['http://evil.example.com/callback', 'https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      // origin must reflect the first ACCEPTABLE uri, not the unacceptable one
      const good = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('pendingId' in good).toBe(true);
      const view = await i.pendingView((good as { pendingId: string }).pendingId);
      expect(view?.origin).toBe('https://claude.ai');
      // the unacceptable plain-http public redirect was never stored → no match
      const bad = await i.createPending({
        client_id: clientId, redirect_uri: 'http://evil.example.com/callback',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('error' in bad).toBe(true);
    });
  });

  // FIX A (display-spoof, multi-origin variant): a client may register several
  // acceptable https origins. The origin the approver sees and the door_name the
  // lease carries must derive from THIS authorization's own redirect_uri, never
  // from the client's first-registered origin — otherwise the approver reads
  // 'claude.ai' while the code is delivered to 'attacker.example'.
  test('the displayed origin equals the redirect_uri origin, not the first-registered origin', async () => {
    await runInDurableObject(reg('t-multiorigin'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/cb', 'https://attacker.example/cb'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'h'.repeat(64);
      const challenge = await s256(verifier);
      // authorize through the SECOND registered origin
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://attacker.example/cb',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      // the approval page must show the SECOND origin, not the first-registered one
      const view = await i.pendingView(pendingId);
      expect(view?.origin).toBe('https://attacker.example');
      expect(view?.origin).not.toBe('https://claude.ai');
      // and the door_name is derived from that same second origin
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://attacker.example/cb', code_verifier: verifier,
      });
      expect(ok).toEqual({ elected_scope: 'reading-room', door_name: 'visit:attacker.example' });
    });
  });

  // DEFECT 2 (client eviction): a client that completed a round-trip (redeemed)
  // is marked approved and survives the 2h sweep; a client that never redeemed
  // is evicted.
  test('a redeemed client survives the 2h sweep; a never-redeemed client is swept', async () => {
    await runInDurableObject(reg('t-sweep'), async (i: RegistrarDO) => {
      const base = Date.now();
      i.now = () => base;
      // client A completes a full round-trip
      const regA = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientA = (regA as { client_id: string }).client_id;
      const verifier = 'g'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientA, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');
      const ok = await i.redeem({
        code: pendingId, client_id: clientA,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect('door_name' in ok).toBe(true);
      // client B never redeems
      const regB = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientB = (regB as { client_id: string }).client_id;
      // advance past created + 2h; the next write sweeps
      i.now = () => base + 2 * 60 * 60 * 1000 + 1000;
      // client A (redeemed → approved) still resolves; this createPending sweeps first
      const stillA = await i.createPending({
        client_id: clientA, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('pendingId' in stillA).toBe(true);
      // client B (never redeemed) was swept → unknown_client
      const goneB = await i.createPending({
        client_id: clientB, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: 'c', resource: 'https://x/mcp', ttlSeconds: 600,
      });
      expect('error' in goneB).toBe(true);
    });
  });

  // Post-JOIN-removal regression: the authcode row is authoritative for
  // client_id, redirect_uri, PKCE, scope, and approver. When the client row
  // is swept (or explicitly deleted), an already-approved code remains valid
  // — pendingView returns the pending's view and redeem succeeds with the
  // elected scope. This pins the accepted post-JOIN-removal behavior (the
  // pre-removal JOIN would have refused; the divergence was reviewed and
  // accepted at the 20260812-b2face gate).
  test('a deleted client row does not orphan an approved authcode', async () => {
    await runInDurableObject(reg('t-sweep-client'), async (i: RegistrarDO) => {
      const reg1 = await i.registerClient({
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        token_endpoint_auth_method: 'none',
      });
      const clientId = (reg1 as { client_id: string }).client_id;
      const verifier = 'i'.repeat(64);
      const challenge = await s256(verifier);
      const pend = await i.createPending({
        client_id: clientId, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_challenge: challenge, resource: 'https://x/mcp', ttlSeconds: 600,
      });
      const pendingId = (pend as { pendingId: string }).pendingId;
      await i.attachApproval(pendingId, 'user_marcus', 'reading-room');

      // Simulate the sweep of an unapproved client: delete the client row
      // directly via SQL to simulate the scenario where the client row
      // is evicted but the approved authcode still lives.
      i.sql.exec('DELETE FROM clients WHERE client_id = ?', clientId);

      // pendingView still returns the pending's view (no JOIN dependency)
      const view = await i.pendingView(pendingId);
      expect(view).toMatchObject({
        client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        origin: 'https://claude.ai',
      });

      // redeem succeeds with the elected scope (no JOIN dependency)
      const ok = await i.redeem({
        code: pendingId, client_id: clientId,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier,
      });
      expect(ok).toMatchObject({ elected_scope: 'reading-room', door_name: 'visit:claude.ai' });
    });
  });
});
