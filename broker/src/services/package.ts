// The package: Julian's identity, served whole or not at all (spec §6).
// Content is fetched from the raw content root at the pinned sha — never a
// local filesystem, never a caller-built URL. The manifest is the only
// namespace; the face is not a GitHub proxy.
import type { Env } from '../env';
import {
  FETCH_TIMEOUT_MS, MANIFEST_PATH, MAX_FILE_BYTES, PIN_KEY,
  RAW_CACHE_TTL_SECONDS,
} from '../package-types';
import type { PackageManifest } from '../package-types';

export type PackageFailure = {
  class: 'integrity' | 'unpinned' | 'invalid-path';
  message: string;
  pinSha: string | null;
};

export type PackageRead =
  | { class: 'ok'; path: string; sha256: string; bytes: number; content: string; pinSha: string }
  | { class: 'held-at-home'; path: string; pinSha: string }
  | PackageFailure;

const UNPINNED: PackageFailure = {
  class: 'unpinned', pinSha: null,
  message: 'no content pin is set — the package cannot be served until /pin-bump writes one',
};

function integrity(message: string, pinSha: string): PackageFailure {
  return { class: 'integrity', message: `${message} (pin ${pinSha})`, pinSha };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

/** Pinned, sha-addressed content: cf edge cache, never the Cache API (P2). */
async function fetchPinned(env: Env, pinSha: string, path: string): Promise<Response> {
  return fetch(`${env.PACKAGE_RAW_BASE}/${pinSha}/${path}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheTtl: RAW_CACHE_TTL_SECONDS, cacheEverything: true },
  } as RequestInit);
}

export async function currentPin(env: Env): Promise<string | null> {
  return env.PIN.get(PIN_KEY);
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
  return { class: 'ok', manifest, pinSha, pinnedAt: manifest.generatedAt ?? null };
}

export async function readPackageFile(env: Env, callerPath: string): Promise<PackageRead> {
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

  let res: Response;
  try {
    res = await fetchPinned(env, pinSha, entry.path); // the entry's path, never the caller's
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
  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256) {
    return integrity(`hash mismatch for ${entry.path}: manifest ${entry.sha256}, fetched ${digest}`, pinSha);
  }
  return {
    class: 'ok', path: entry.path, sha256: entry.sha256,
    bytes: bytes.byteLength, content: new TextDecoder().decode(bytes), pinSha,
  };
}
