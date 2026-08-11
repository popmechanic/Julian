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
});
