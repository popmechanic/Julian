import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import {
  loadManifest, readPackageFile, readPackageFileVerified, readResponseBody, splitIntoParts,
} from '../src/services/package';
import { MAX_FILE_BYTES, PART_TARGET_BYTES, PART_THRESHOLD_BYTES } from '../src/package-types';
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

/** A PIN binding whose get() throws — the KV read must never reject out. */
function throwingPinEnv(): Env {
  return {
    PACKAGE_RAW_BASE: RAW,
    PIN: {
      async get() { throw new Error('KV unavailable'); },
      async put() { throw new Error('KV unavailable'); },
    } as unknown as KVNamespace,
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

interface Entry { path: string; sha256: string; bytes: number }

/** A manifest carrying exactly the entries a test cares about. */
function manifestOf(...files: Entry[]): string {
  return JSON.stringify({ generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z', files });
}

async function entryFor(path: string, text: string): Promise<Entry> {
  const bytes = new TextEncoder().encode(text);
  return { path, sha256: await sha256Hex(text), bytes: bytes.byteLength };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Records the `cf` options of every upstream fetch while leaving the
 * fetchMock interceptors to answer them — `fetchMock` sees the request, but
 * only the global seam sees the cache directives the double-look depends on.
 */
function fetchSpy(): { inits: RequestInit[]; restore: () => void } {
  const inits: RequestInit[] = [];
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    inits.push(init ?? {});
    return original(input as RequestInfo, init);
  });
  return { inits, restore: () => vi.unstubAllGlobals() };
}

function cfOf(init: RequestInit): Record<string, unknown> {
  return (init as { cf?: Record<string, unknown> }).cf ?? {};
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

  test('a throwing PIN KV binding is a typed integrity failure, never a rejection', async () => {
    const r = await loadManifest(throwingPinEnv());
    expect(r).toEqual({ class: 'integrity', message: 'pin read failed', pinSha: null });
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
      expect(r.sha256).toBe(await sha256Hex(AGENT_TEXT));
      expect(r.bytes).toBe(AGENT_TEXT.length);
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
    expect(r).toEqual({ class: 'held-at-home', path: 'memory/mail-journal.md', pinSha: PIN });
  });

  test.each([
    // Note: 'AGENT%2emd' is deliberately excluded here — decodeURIComponent
    // is hex-case-insensitive, so it decodes identically to 'AGENT%2Emd'
    // (a legal path, covered in the dedicated 'ok' test below). Listing it
    // as hostile would contradict the decode-once rule for a string that
    // is byte-for-byte equivalent after decoding.
    '../soul/01-naming.md', './AGENT.md', '/AGENT.md',
    'soul\\01-naming.md', 'AGENT%252Emd',
  ])('hostile path %s is invalid-path, pinSha null, and never fetched', async (p) => {
    const r = await readPackageFile(env(), p);
    expect(r.class).toBe('invalid-path');
    if (r.class === 'invalid-path') expect(r.pinSha).toBeNull();
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

  test('a manifest-declared oversize file is rejected before any fetch is issued', async () => {
    const body = JSON.stringify({
      generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'big.md', sha256: '0'.repeat(64), bytes: 600 * 1024 }],
    });
    intercept('package-manifest.json', body);
    // Deliberately no intercept for big.md: disableNetConnect() means a fetch
    // here would throw, not silently pass. assertNoPendingInterceptors (in
    // afterEach) proves no interceptor was left unconsumed for it either way,
    // and the message text below distinguishes "rejected before fetch" from
    // "fetch itself failed".
    const r = await readPackageFile(env(), 'big.md');
    expect(r.class).toBe('integrity');
    if (r.class === 'integrity') {
      expect(r.message).toContain(String(MAX_FILE_BYTES));
      expect(r.message).toContain('big.md');
      expect(r.pinSha).toBe(PIN);
    }
  });

  test('a response whose content-length lies past the cap is rejected before the body is buffered', async () => {
    const body = JSON.stringify({
      generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'lying.md', sha256: '0'.repeat(64), bytes: 10 }], // manifest says small
    });
    intercept('package-manifest.json', body);
    fetchMock.get(RAW)
      .intercept({ path: `/${PIN}/lying.md` })
      .reply(200, 'short body', { headers: { 'content-length': String(600 * 1024) } });
    const r = await readPackageFile(env(), 'lying.md');
    expect(r.class).toBe('integrity');
    if (r.class === 'integrity') {
      expect(r.message).toContain(String(MAX_FILE_BYTES));
      expect(r.message).toContain('lying.md');
      expect(r.pinSha).toBe(PIN);
    }
  });

  test('a file that actually exceeds the cap still fails loud after buffering (fallback)', async () => {
    const big = 'x'.repeat(600 * 1024);
    const body = JSON.stringify({
      generatedFrom: PIN, generatedAt: '2026-08-12T00:00:00Z',
      files: [{ path: 'big.md', sha256: await sha256Hex(big), bytes: 10 }], // manifest under-declares
    });
    intercept('package-manifest.json', body);
    intercept('big.md', big);
    const r = await readPackageFile(env(), 'big.md');
    expect(r.class).toBe('integrity');
    if (r.class === 'integrity') {
      expect(r.message).toContain(String(MAX_FILE_BYTES));
      expect(r.pinSha).toBe(PIN);
    }
  });
});

describe('readResponseBody', () => {
  test('a body-read failure is wrapped as a loud integrity error, never a rejection', async () => {
    const failing = { arrayBuffer: () => Promise.reject(new Error('stream reset')) };
    const r = await readResponseBody(failing, 'AGENT.md', PIN);
    expect(r).not.toBeInstanceOf(ArrayBuffer);
    if (!(r instanceof ArrayBuffer)) {
      expect(r.class).toBe('integrity');
      expect(r.message).toContain('AGENT.md');
      expect(r.message).toContain('body read failed');
      expect(r.pinSha).toBe(PIN);
    }
  });

  test('a healthy body still round-trips through the wrapper', async () => {
    const ok = { arrayBuffer: () => Promise.resolve(new TextEncoder().encode('hi').buffer) };
    const r = await readResponseBody(ok, 'AGENT.md', PIN);
    expect(r).toBeInstanceOf(ArrayBuffer);
  });
});

// ── numbered parts (spec §9 / issue #30) ────────────────────────────────────

const LINE = 'the package travels whole, or not at all.\n'; // 42 bytes
const BIG_TEXT = LINE.repeat(2200);                          // 92 400 bytes
/** A 4-byte code point sitting exactly across the target boundary. */
const CLEF = '\u{1D11E}';
const STRADDLE_TEXT = 'a'.repeat(PART_TARGET_BYTES - 2) + CLEF + 'b'.repeat(10_000);

describe('splitIntoParts', () => {
  test('accumulates whole code points and never exceeds the target', () => {
    const parts = splitIntoParts(BIG_TEXT);
    expect(parts.length).toBe(4);
    for (const p of parts) expect(utf8(p).byteLength).toBeLessThanOrEqual(PART_TARGET_BYTES);
    expect(parts.join('')).toBe(BIG_TEXT);
  });

  test('a multi-byte code point straddling the boundary lands whole in exactly one part', () => {
    const parts = splitIntoParts(STRADDLE_TEXT);
    expect(parts.length).toBe(2);
    // a naive byte slice at PART_TARGET_BYTES would cut the clef in half
    expect(utf8(parts[0]).byteLength).toBe(PART_TARGET_BYTES - 2);
    expect(parts.filter((p) => p.includes(CLEF)).length).toBe(1);
    expect(parts[1].startsWith(CLEF)).toBe(true);
    // and no part carries a replacement character, the tell of a split code point
    for (const p of parts) expect(new TextDecoder().decode(utf8(p))).not.toContain('�');
  });
});

describe('readPackageFileVerified — parts', () => {
  test('a parted file yields M parts that reassemble byte-for-byte, each with a verifying partSha256', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    expect(entry.bytes).toBeGreaterThan(PART_THRESHOLD_BYTES);
    const collected: string[] = [];
    let announced = 0;
    for (let n = 1; n <= 4; n += 1) {
      intercept('package-manifest.json', manifestOf(entry));
      intercept('catalog.md', BIG_TEXT);
      const r = await readPackageFileVerified(env(), 'catalog.md', n);
      expect(r.class, `part ${n}`).toBe('ok');
      if (r.class !== 'ok') return;
      announced = r.parts ?? 0;
      expect(r.parts).toBe(4);
      expect(r.part).toBe(n);
      // the whole-file proof rides every part, identical across all of them
      expect(r.fileSha256).toBe(entry.sha256);
      expect(r.sha256).toBe(entry.sha256);
      expect(r.bytes).toBe(entry.bytes);
      expect(r.partBytes).toBe(utf8(r.content).byteLength);
      expect(r.partSha256).toBe(await sha256Hex(r.content));
      collected.push(r.content);
    }
    expect(announced).toBe(4);
    expect(utf8(collected.join(''))).toEqual(utf8(BIG_TEXT));
  });

  test('a parted file read with no part is a typed `parts` refusal naming M', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const r = await readPackageFileVerified(env(), 'catalog.md');
    expect(r.class).toBe('parts');
    if (r.class !== 'parts') return;
    expect(r.message).toBe(
      'this file serves in 4 parts; request part 1…4 and verify every part carries the same fileSha256',
    );
    expect(r.parts).toBe(4);
    expect(r.pinSha).toBe(PIN);
  });

  test('part M+1 is part-out-of-range, naming the range it may ask for', async () => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const r = await readPackageFileVerified(env(), 'catalog.md', 5);
    expect(r.class).toBe('part-out-of-range');
    if (r.class !== 'part-out-of-range') return;
    expect(r.message).toContain('1…4');
    expect(r.parts).toBe(4);
  });

  test.each([0, -1, 1.5])('a non-part-shaped part argument %s is part-out-of-range', async (n) => {
    const entry = await entryFor('catalog.md', BIG_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('catalog.md', BIG_TEXT);
    const r = await readPackageFileVerified(env(), 'catalog.md', n);
    expect(r.class).toBe('part-out-of-range');
  });

  test('a part argument on an unparted file is refused before a byte crosses the wire', async () => {
    // Only the manifest is intercepted: disableNetConnect() means a fetch of
    // AGENT.md here would throw rather than pass silently.
    intercept('package-manifest.json', await manifestBody());
    const r = await readPackageFileVerified(env(), 'AGENT.md', 1);
    expect(r.class).toBe('part-out-of-range');
    if (r.class !== 'part-out-of-range') return;
    expect(r.message).toContain('this file serves whole; omit part');
    expect(r.pinSha).toBe(PIN);
  });

  test('a file at exactly the threshold still serves whole — the boundary is strict', async () => {
    const text = 'z'.repeat(PART_THRESHOLD_BYTES);
    const entry = await entryFor('edge.md', text);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('edge.md', text);
    const r = await readPackageFileVerified(env(), 'edge.md');
    expect(r.class).toBe('ok');
    if (r.class !== 'ok') return;
    expect(r.content).toBe(text);
    expect(r.part).toBeUndefined();
    expect(r.parts).toBeUndefined();
  });
});

// ── the bounded, atomic second look (spec §9 / SEC HIGH-4) ──────────────────

const TRUE_TEXT = 'x'.repeat(64);
const FAKE_TEXT = 'y'.repeat(64); // same length, different bytes

describe('readPackageFileVerified — the in-call second look', () => {
  test('a length-verified mismatch refetches once past the edge cache and reports it', async () => {
    const spy = fetchSpy();
    try {
      const entry = await entryFor('AGENT.md', TRUE_TEXT);
      intercept('package-manifest.json', manifestOf(entry));
      intercept('AGENT.md', FAKE_TEXT);
      intercept('AGENT.md', FAKE_TEXT);
      const r = await readPackageFileVerified(env(), 'AGENT.md');
      expect(r.class).toBe('integrity');
      if (r.class !== 'integrity') return;
      expect(r.mismatchLengthVerified).toBe(true);
      expect(r.message).toContain('hash mismatch');
      expect(r.message).not.toContain(FAKE_TEXT);

      // manifest, then the file twice — and the second look is cache-immune
      expect(spy.inits.length).toBe(3);
      expect(cfOf(spy.inits[1])).toEqual({ cacheTtl: 300, cacheEverything: true });
      expect(cfOf(spy.inits[2])).toEqual({ cacheTtl: 0, cacheEverything: false });
    } finally {
      spy.restore();
    }
  });

  test('a second look that comes back clean serves the file and reports no mismatch', async () => {
    const spy = fetchSpy();
    try {
      const entry = await entryFor('AGENT.md', TRUE_TEXT);
      intercept('package-manifest.json', manifestOf(entry));
      intercept('AGENT.md', FAKE_TEXT);
      intercept('AGENT.md', TRUE_TEXT);
      const r = await readPackageFileVerified(env(), 'AGENT.md');
      expect(r.class).toBe('ok');
      if (r.class !== 'ok') return;
      expect(r.content).toBe(TRUE_TEXT);
      expect(spy.inits.length).toBe(3);
    } finally {
      spy.restore();
    }
  });

  test('a short body is a truncation: one fetch, plain integrity, nothing to latch on', async () => {
    const spy = fetchSpy();
    try {
      const entry = await entryFor('AGENT.md', TRUE_TEXT);
      intercept('package-manifest.json', manifestOf(entry));
      intercept('AGENT.md', 'x'.repeat(10));
      const r = await readPackageFileVerified(env(), 'AGENT.md');
      expect(r.class).toBe('integrity');
      if (r.class !== 'integrity') return;
      expect(r.mismatchLengthVerified).toBeUndefined();
      expect(spy.inits.length).toBe(2);
    } finally {
      spy.restore();
    }
  });

  test('a second look that cannot be taken fails loud without claiming a verified mismatch', async () => {
    const entry = await entryFor('AGENT.md', TRUE_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('AGENT.md', FAKE_TEXT);
    intercept('AGENT.md', 'upstream gone', 502);
    const r = await readPackageFileVerified(env(), 'AGENT.md');
    expect(r.class).toBe('integrity');
    if (r.class !== 'integrity') return;
    expect(r.mismatchLengthVerified).toBeUndefined();
  });

  test('a length-verified mismatch whose second look changes length is not a verified mismatch', async () => {
    const entry = await entryFor('AGENT.md', TRUE_TEXT);
    intercept('package-manifest.json', manifestOf(entry));
    intercept('AGENT.md', FAKE_TEXT);
    intercept('AGENT.md', 'y'.repeat(10));
    const r = await readPackageFileVerified(env(), 'AGENT.md');
    expect(r.class).toBe('integrity');
    if (r.class !== 'integrity') return;
    expect(r.mismatchLengthVerified).toBeUndefined();
  });

  test('readPackageFile stays the whole-file wrapper resources/read still calls', async () => {
    intercept('package-manifest.json', await manifestBody());
    intercept('AGENT.md', AGENT_TEXT);
    const r = await readPackageFile(env(), 'AGENT.md');
    expect(r.class).toBe('ok');
    if (r.class === 'ok') expect(r.content).toBe(AGENT_TEXT);
  });
});
