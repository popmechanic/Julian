// The package: Julian's identity, served whole or not at all (spec §6).
// Content is fetched from the raw content root at the pinned sha — never a
// local filesystem, never a caller-built URL. The manifest is the only
// namespace; the face is not a GitHub proxy.
import type { Env } from '../env';
import {
  FETCH_TIMEOUT_MS, MANIFEST_PATH, MAX_FILE_BYTES, PART_TARGET_BYTES,
  PART_THRESHOLD_BYTES, PIN_KEY, RAW_CACHE_TTL_SECONDS,
} from '../package-types';
import type { ManifestEntry, PackageManifest } from '../package-types';

/**
 * Every way a package read can end badly, each one typed so the face can say
 * what died and what to do. Three are raised here (`integrity`, `unpinned`,
 * `invalid-path`, plus the two part-shaped ones); the three sitting/latch
 * classes are raised by the read policy in `mcp.ts`, which owns that argument
 * whole (spec §9).
 */
export type PackageFailureClass =
  | 'integrity' | 'unpinned' | 'invalid-path'
  | 'pin-moved' | 'part-pin-moved' | 'parts' | 'part-out-of-range' | 'integrity-latched';

export type PackageFailure = {
  class: PackageFailureClass;
  message: string;
  pinSha: string | null;
  /**
   * Set only when a hash mismatch arrived at exactly the manifest's declared
   * length AND survived the in-call `cacheTtl: 0` refetch. It is the one
   * signal the caller may latch on — truncation and transport damage never
   * carry it (SEC HIGH-4).
   */
  mismatchLengthVerified?: true;
  /** Server-authoritative part count, on the two part-shaped refusals. */
  parts?: number;
};

export type PackageRead =
  | {
    class: 'ok'; path: string; sha256: string; bytes: number; content: string; pinSha: string;
    // Present only on a part read. `sha256`/`bytes` keep naming the WHOLE
    // file — `fileSha256` restates it under the name the wake text uses, and
    // `partBytes`/`partSha256` describe the slice in `content`.
    part?: number; parts?: number; partBytes?: number; partSha256?: string; fileSha256?: string;
  }
  | { class: 'held-at-home'; path: string; pinSha: string }
  | PackageFailure;

const UNPINNED: PackageFailure = {
  class: 'unpinned', pinSha: null,
  message: 'no content pin is set — the package cannot be served until /pin-bump writes one',
};

function integrity(message: string, pinSha: string): PackageFailure {
  return { class: 'integrity', message: `${message} (pin ${pinSha})`, pinSha };
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTF-8 width of one code point — the unit the split is allowed to move in. */
function codePointBytes(cp: string): number {
  const c = cp.codePointAt(0) as number;
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

/**
 * Split decoded text into parts of at most `PART_TARGET_BYTES` UTF-8 bytes,
 * accumulating whole code points: a part boundary never lands inside a
 * character, so every part decodes on its own and the concatenation is
 * byte-for-byte the original (spec §9 / PROTO N4).
 */
export function splitIntoParts(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const cp of text) {
    const width = codePointBytes(cp);
    if (currentBytes > 0 && currentBytes + width > PART_TARGET_BYTES) {
      parts.push(current.join(''));
      current = [];
      currentBytes = 0;
    }
    current.push(cp);
    currentBytes += width;
  }
  if (currentBytes > 0 || parts.length === 0) parts.push(current.join(''));
  return parts;
}

/**
 * One decode, then reject any residual '%'; then reject backslashes,
 * leading '/', empty/'.'/'..' segments (spec N4). Returns the decoded path
 * or null. The returned value is used ONLY to look up the manifest entry —
 * the fetch URL is always built from the entry's own path.
 */
export function normalizePath(callerPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(callerPath); } catch { return null; }
  if (decoded.includes('%')) return null;
  if (decoded.includes('\\')) return null;
  if (decoded.startsWith('/')) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return decoded;
}

/**
 * Pinned, sha-addressed content: cf edge cache, never the Cache API (P2).
 * `fresh` is the second look of the double-check — it must bypass the 300 s
 * edge cache, which would otherwise re-serve the very bytes under suspicion.
 */
async function fetchPinned(
  env: Env, pinSha: string, path: string, fresh = false,
): Promise<Response> {
  return fetch(`${env.PACKAGE_RAW_BASE}/${pinSha}/${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: fresh
      ? { cacheTtl: 0, cacheEverything: false }
      : { cacheTtl: RAW_CACHE_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);
}

/**
 * @internal `loadManifest` is the public face for reading the pin; this is
 * exported only because mcp.ts's read policy (spec §9's sitting/latch, which
 * runs ahead of any fetch) needs the pin without paying for a manifest fetch.
 * No other caller should reach for it.
 */
export async function currentPin(env: Env): Promise<string | null> {
  return env.PIN.get(PIN_KEY);
}

/** One manifest entry, shaped enough to trust before it names a fetch. */
function entryIsWellFormed(entry: unknown): entry is ManifestEntry {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.path === 'string'
    && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)
    && typeof e.bytes === 'number' && Number.isInteger(e.bytes) && e.bytes >= 0;
}

/**
 * Unwraps a fetched response body, wrapping any mid-read failure (stream
 * reset, timeout-after-headers) as a typed integrity error instead of
 * letting the module reject — fail loud, never partial (spec §6). Takes
 * only the `arrayBuffer` method so a plain stub can drive it in tests.
 */
export async function readResponseBody(
  res: Pick<Response, 'arrayBuffer'>,
  path: string,
  pinSha: string,
): Promise<ArrayBuffer | PackageFailure> {
  try {
    return await res.arrayBuffer();
  } catch {
    return integrity(`body read failed for ${path}`, pinSha);
  }
}

export async function loadManifest(
  env: Env,
): Promise<{ class: 'ok'; manifest: PackageManifest; pinSha: string; pinnedAt: string | null } | PackageFailure> {
  let pinSha: string | null;
  try {
    pinSha = await currentPin(env);
  } catch {
    return { class: 'integrity', message: 'pin read failed', pinSha: null };
  }
  if (!pinSha) return UNPINNED;
  let res: Response;
  try {
    res = await fetchPinned(env, pinSha, MANIFEST_PATH);
  } catch {
    return integrity('manifest fetch failed', pinSha);
  }
  if (!res.ok) return integrity(`manifest fetch returned ${res.status}`, pinSha);
  let manifest: PackageManifest;
  try {
    manifest = await res.json() as PackageManifest;
  } catch {
    return integrity('manifest is not JSON', pinSha);
  }
  if (!Array.isArray(manifest.files)) return integrity('manifest has no files list', pinSha);
  // Every entry must name a plain path, a 64-hex sha256, and a non-negative
  // integer byte count before any of it is trusted to name a fetch — a
  // malformed entry is a typed refusal, never a crash reading `.path` off
  // something that turns out not to have one.
  if (!manifest.files.every(entryIsWellFormed)) {
    return integrity('manifest entry malformed', pinSha);
  }
  return { class: 'ok', manifest, pinSha, pinnedAt: manifest.generatedAt ?? null };
}

/** One upstream look: the caps, the body, and the digest of what arrived. */
async function fetchOnce(
  env: Env, pinSha: string, entry: ManifestEntry, fresh: boolean,
): Promise<{ bytes: ArrayBuffer; digest: string } | PackageFailure> {
  let res: Response;
  try {
    res = await fetchPinned(env, pinSha, entry.path, fresh); // the entry's path, never the caller's
  } catch {
    return integrity(`fetch failed for ${entry.path}`, pinSha);
  }
  if (!res.ok) return integrity(`fetch returned ${res.status} for ${entry.path}`, pinSha);

  // Pre-check the advertised size before buffering the whole body, when the
  // upstream response bothers to advertise one.
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_FILE_BYTES) {
    return integrity(
      `${entry.path} exceeds the ${MAX_FILE_BYTES}-byte cap (content-length ${contentLength})`,
      pinSha,
    );
  }

  const bodyResult = await readResponseBody(res, entry.path, pinSha);
  if (!(bodyResult instanceof ArrayBuffer)) return bodyResult;
  const bytes = bodyResult;

  // Fallback safety net: a response that lied about (or omitted) its
  // content-length is still caught after buffering, never truncated.
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return integrity(`${entry.path} exceeds the ${MAX_FILE_BYTES}-byte cap`, pinSha);
  }
  return { bytes, digest: await sha256Hex(bytes) };
}

/**
 * Fetch the whole file and prove it against the manifest hash.
 *
 * The double-check of spec §9 lives here and is atomic inside one call: a
 * mismatch whose body arrived at exactly the declared length is looked at once
 * more with `cacheTtl: 0`, so the 300 s edge cache cannot simply re-serve the
 * suspect bytes. Only a second, still length-verified mismatch carries
 * `mismatchLengthVerified` — everything else (truncation, a short second look,
 * an upstream that fell over) stays a loud, non-latching `integrity`.
 */
async function fetchAndVerify(
  env: Env, pinSha: string, entry: ManifestEntry,
): Promise<ArrayBuffer | PackageFailure> {
  const mismatch = (digest: string) =>
    `hash mismatch for ${entry.path}: manifest ${entry.sha256}, fetched ${digest}`;

  const first = await fetchOnce(env, pinSha, entry, false);
  if (!('digest' in first)) return first;
  if (first.digest === entry.sha256) return first.bytes;
  if (first.bytes.byteLength !== entry.bytes) return integrity(mismatch(first.digest), pinSha);

  const second = await fetchOnce(env, pinSha, entry, true);
  if (!('digest' in second)) return second;
  if (second.digest === entry.sha256) return second.bytes;
  if (second.bytes.byteLength !== entry.bytes) return integrity(mismatch(second.digest), pinSha);
  return { ...integrity(mismatch(second.digest), pinSha), mismatchLengthVerified: true };
}

/**
 * The whole read: verify the file, then slice. Never an HTTP Range — a ranged
 * body cannot be checked against the manifest hash, so the proof would be
 * gone exactly where it is most needed (spec §9).
 */
export async function readPackageFileVerified(
  env: Env, callerPath: string, part?: number,
): Promise<PackageRead> {
  const path = normalizePath(callerPath);
  if (path === null) {
    return { class: 'invalid-path', message: 'path is not a plain manifest path', pinSha: null };
  }
  const loaded = await loadManifest(env);
  if (loaded.class !== 'ok') return loaded;
  const { manifest, pinSha } = loaded;

  const entry = manifest.files.find((f) => f.path === path);
  // Not in the manifest: held at home by policy — a refusal, not a broken
  // package (review Identity HIGH-2). Distinct from every integrity error.
  if (!entry) return { class: 'held-at-home', path, pinSha };

  // Enforce the cap before ever issuing the fetch: a manifest entry that
  // already declares itself oversized is refused with zero bytes crossing
  // the wire (spec §6).
  if (entry.bytes > MAX_FILE_BYTES) {
    return integrity(
      `${entry.path} exceeds the ${MAX_FILE_BYTES}-byte cap (manifest declares ${entry.bytes} bytes)`,
      pinSha,
    );
  }

  const parted = entry.bytes > PART_THRESHOLD_BYTES;
  // A part asked of a whole file is an argument error, answered before a
  // single byte crosses the wire — there is no M to name and none to learn.
  if (!parted && part !== undefined) {
    return { class: 'part-out-of-range', pinSha, message: 'this file serves whole; omit part' };
  }

  const verified = await fetchAndVerify(env, pinSha, entry);
  if (!(verified instanceof ArrayBuffer)) return verified;
  const text = new TextDecoder().decode(verified);

  if (!parted) {
    return {
      class: 'ok', path: entry.path, sha256: entry.sha256,
      bytes: verified.byteLength, content: text, pinSha,
    };
  }

  // M is the server's arithmetic, never the caller's: the split is proven
  // against the verified whole, so the count cannot be argued with.
  const chunks = splitIntoParts(text);
  const count = chunks.length;
  if (part === undefined) {
    return {
      class: 'parts', pinSha, parts: count,
      message: `this file serves in ${count} parts; request part 1…${count} and verify every part carries the same fileSha256`,
    };
  }
  if (!Number.isInteger(part) || part < 1 || part > count) {
    return {
      class: 'part-out-of-range', pinSha, parts: count,
      message: `this file serves in ${count} parts; part ${part} is outside 1…${count} — request part 1…${count}`,
    };
  }

  const chunk = chunks[part - 1];
  const chunkBytes = new TextEncoder().encode(chunk);
  return {
    class: 'ok', path: entry.path, sha256: entry.sha256,
    bytes: verified.byteLength, content: chunk, pinSha,
    part, parts: count, partBytes: chunkBytes.byteLength,
    // A transport checksum for the client only: nothing on this side exists
    // to check it against, so it is never grounds for a latch (SEC NEW-15).
    partSha256: await sha256Hex(chunkBytes),
    fileSha256: entry.sha256,
  };
}

/** The whole-file read, kept for `resources/read`, which carries no part. */
export async function readPackageFile(env: Env, callerPath: string): Promise<PackageRead> {
  return readPackageFileVerified(env, callerPath);
}
