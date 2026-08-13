// The package contract: what the manifest is, and the caps every consumer
// of the package share. The manifest is committed to the repo, regenerated
// by scripts/package-manifest.ts, and fetched at the pinned sha — it is the
// enumeration mechanism, the definition of "whole", and the waking-friction
// hashes, all at once (spec §6). It never lists itself (N3): the pin sha is
// the manifest's own integrity statement.
export interface ManifestEntry {
  path: string;    // repo-relative, forward slashes, no leading '/'
  sha256: string;  // lowercase hex of the file bytes
  bytes: number;
}

export interface PackageManifest {
  generatedFrom: string;  // git commit sha the generator ran at
  generatedAt: string;    // ISO timestamp of generation
  files: ManifestEntry[]; // sorted by path
}

/** The one KV key in the PIN namespace. */
export const PIN_KEY = 'pin-sha';
/** Where the manifest lives inside the pinned tree. */
export const MANIFEST_PATH = 'package-manifest.json';
/** Per-file size cap — fail loud past it, never truncate (spec §6). */
export const MAX_FILE_BYTES = 512 * 1024;
/**
 * Above this many manifest bytes a file serves only in numbered parts
 * (spec §9 / issue #30). Strictly above: a file of exactly this size still
 * serves whole. Chosen so `catalog.md` actually parts.
 */
export const PART_THRESHOLD_BYTES = 32_768;
/**
 * Target UTF-8 size of one part. The split accumulates whole code points, so
 * a part is at most this many bytes and usually a little under.
 */
export const PART_TARGET_BYTES = 24_576;
/** Upstream fetch timeout. */
export const FETCH_TIMEOUT_MS = 10_000;
/** cf edge-cache TTL for pinned (immutable) content. */
export const RAW_CACHE_TTL_SECONDS = 300;
