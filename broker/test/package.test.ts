import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { loadManifest, readPackageFile } from '../src/services/package';
import type { Env } from '../src/env';

const RAW = 'https://raw.test';
const PIN = 'a'.repeat(40);

beforeAll(() => { fetchMock.activate(); fetchMock.disableNetConnect(); });
afterEach(() => fetchMock.assertNoPendingInterceptors());

function kvStub(entries: Record<string, string> = {}): KVNamespace {
  const map = new Map(Object.entries(entries));
  return {
    async get(key: string) { return map.get(key) ?? null; },
    async put(key: string, value: string) { map.set(key, value); },
  } as unknown as KVNamespace;
}

function env(pin: string | null = PIN): Env {
  return {
    PACKAGE_RAW_BASE: RAW,
    PIN: kvStub(pin ? { 'pin-sha': pin } : {}),
  } as unknown as Env;
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const AGENT_TEXT = '# AGENT\nJulian, lent.\n';

async function manifestBody() {
  return JSON.stringify({
    generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
    files: [{ path: 'AGENT.md', sha256: await sha256Hex(AGENT_TEXT), bytes: AGENT_TEXT.length }],
  });
}

function intercept(path: string, body: string, status = 200) {
  fetchMock.get(RAW).intercept({ path: `/${PIN}/${path}` }).reply(status, body);
}

describe('loadManifest', () => {
  test('fetches the manifest at the pinned sha', async () => {
    intercept('package-manifest.json', await manifestBody());
    const r = await loadManifest(env());
    expect(r.class).toBe('ok');
    if (r.class === 'ok') {
      expect(r.pinSha).toBe(PIN);
      expect(r.manifest.files[0].path).toBe('AGENT.md');
    }
  });

  test('no pin set → typed unpinned failure, no fetch', async () => {
    const r = await loadManifest(env(null));
    expect(r.class).toBe('unpinned');
  });

  test('an upstream failure is a loud integrity error carrying the pin sha', async () => {
    intercept('package-manifest.json', 'gone', 502);
    const r = await loadManifest(env());
    expect(r.class).toBe('integrity');
    if (r.class === 'integrity') expect(r.pinSha).toBe(PIN);
  });
});

describe('readPackageFile', () => {
  test('a manifest path round-trips content, hash-verified', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const r = await readPackageFile(env(), 'AGENT.md');
    expect(r.class).toBe('ok');
    if (r.class === 'ok') {
      expect(r.content).toBe(AGENT_TEXT);
      expect(r.pinSha).toBe(PIN);
    }
  });

  test('tampered content fails loud with the pin sha, never partial', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT + 'TAMPERED');
    const r = await readPackageFile(env(), 'AGENT.md');
    expect(r.class).toBe('integrity');
    if (r.class === 'integrity') {
      expect(r.pinSha).toBe(PIN);
      expect(r.message).toContain(PIN);
      expect('content' in r).toBe(false);
    }
  });

  test('a path the manifest omits is held-at-home — a refusal, not damage', async () => {
    intercept('package-manifest.json', await manifestBody());
    const r = await readPackageFile(env(), 'memory/mail-journal.md');
    expect(r.class).toBe('held-at-home');
  });

  test.each([
    // Note: 'AGENT%2emd' is deliberately excluded here — decodeURIComponent
    // is hex-case-insensitive, so it decodes identically to 'AGENT%2Emd'
    // (a legal path, covered in the dedicated 'ok' test below). Listing it
    // as hostile would contradict the decode-once rule for a string that
    // is byte-for-byte equivalent after decoding.
    '../soul/01-naming.md', './AGENT.md', '/AGENT.md',
    'soul\\01-naming.md', 'AGENT%252Emd',
  ])('hostile path %s is invalid-path and never fetched', async (p) => {
    const r = await readPackageFile(env(), p);
    expect(r.class).toBe('invalid-path');
  });

  test('a single percent-decode is applied, then residual %% rejected', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    // 'AGENT%2Emd' arrives once-encoded: decodes to 'AGENT.md', a legal
    // manifest path — one decode, then check the whole decoded path.
    const r = await readPackageFile(env(), 'AGENT%2Emd');
    expect(r.class).toBe('ok');
  });

  test('a double-encoded path leaves a residual % after one decode and is rejected', async () => {
    // 'AGENT%252Emd' decodes once to 'AGENT%2Emd' — the residual '%' is
    // rejected before any fetch happens.
    const r = await readPackageFile(env(), 'AGENT%252Emd');
    expect(r.class).toBe('invalid-path');
  });

  test('a file past the size cap fails loud', async () => {
    const big = 'x'.repeat(600 * 1024);
    const body = JSON.stringify({
      generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'big.md', sha256: await sha256Hex(big), bytes: big.length }],
    });
    intercept('package-manifest.json', body);
    intercept('big.md', big);
    const r = await readPackageFile(env(), 'big.md');
    expect(r.class).toBe('integrity');
  });
});
