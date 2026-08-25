// scripts/lib/fireproof-archive.ts — the authoritative archive, opened carefully.
//
// Three disciplines live here, and nothing else:
//   1. Temp-dir safety. Decrypted plaintext and escrowed keys touch disk exactly
//      once, inside a directory that is provably not under $HOME (a TMPDIR that
//      points at a synced folder would ship the March conversations to a cloud
//      the moment they were written) and that is removed on every exit path.
//   2. Provenance. The tarball is digest-asserted before it is opened, and every
//      member extracted from it is re-hashed against the archive's own
//      MANIFEST.txt — so a corrupted or substituted member is caught here rather
//      than becoming a silently wrong row on the stream.
//   3. Read-only SQLite. The three catalogues (dashboard, D1, R2 metadata) are
//      opened readonly and queried by name; nothing in this file writes to them.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { LedgerInfo } from './fireproof-types';

export function assertSafeTmp(dir: string): void {
  const real = existsSync(dir) ? realpathSync(dir) : dir;
  if (real.startsWith(homedir())) {
    throw new Error('temp dir must not be under $HOME (TMPDIR may point at a synced folder)');
  }
  if (!real.startsWith('/private/var/folders/') && !real.startsWith('/tmp/')) {
    throw new Error(`temp dir must be under /private/var/folders or /tmp, got ${real}`);
  }
}

// A previous run killed with SIGKILL leaves plaintext behind. Sweep first, so
// the only fp-import-* directory in play is the one this run owns.
export function sweepStaleTmp(): string[] {
  const swept: string[] = [];
  for (const d of readdirSync(tmpdir())) {
    if (d.startsWith('fp-import-')) {
      rmSync(join(tmpdir(), d), { recursive: true, force: true });
      swept.push(d);
    }
  }
  return swept;
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fp-import-'));
  assertSafeTmp(dir);
  // Three removal paths, because there are three ways out: return, throw, signal.
  // `process.on('exit')` must stay synchronous — an async cleanup never runs there.
  const clean = () => rmSync(dir, { recursive: true, force: true });
  const onSig = () => {
    clean();
    process.exit(130);
  };
  process.on('exit', clean);
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  try {
    return await fn(dir);
  } finally {
    clean();
    process.off('exit', clean);
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

export async function verifyArchive(path: string, sha: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`archive not found: ${path}`);
  const h = createHash('sha256');
  h.update(readFileSync(path));
  const got = h.digest('hex');
  if (got !== sha) throw new Error(`archive digest mismatch: ${got} != ${sha}`);
}

export async function extractMembers(archive: string, members: string[], dest: string): Promise<void> {
  const p = Bun.spawn(['tar', '-xzf', archive, '-C', dest, ...members], { stdout: 'ignore', stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(`tar failed: ${await new Response(p.stderr).text()}`);
}

// MANIFEST.txt lines are `./path  size  sha256`. A member the manifest does not
// name is itself a mismatch — an unvouched-for file is exactly what this check
// exists to catch.
export function verifyAgainstManifest(root: string, manifestText: string, members: string[]): string[] {
  const expected = new Map<string, string>();
  for (const line of manifestText.split('\n')) {
    const m = line.match(/^(\.\/\S+)\s+\d+\s+([0-9a-f]{64})$/);
    if (m) expected.set(m[1], m[2]);
  }
  const bad: string[] = [];
  for (const rel of members) {
    const want = expected.get(rel);
    if (!want) {
      bad.push(rel);
      continue;
    }
    const full = join(root, rel);
    if (!existsSync(full)) {
      bad.push(rel);
      continue;
    }
    const h = createHash('sha256');
    h.update(readFileSync(full));
    if (h.digest('hex') !== want) bad.push(rel);
  }
  return bad;
}

// The three catalogues were snapshotted live and their headers say WAL, but the
// archive carries no `-wal`/`-shm` sidecars. A plain readonly open therefore
// fails ("unable to open database file") because SQLite cannot create the shared
// -shm it thinks it needs. `immutable=1` is the honest description of what these
// files are — a frozen snapshot nobody else is writing — and it opens them
// without SQLite touching a single byte on disk.
export function openReadonly(path: string): Database {
  const uri = `file:${encodeURI(path).replace(/\?/g, '%3F').replace(/#/g, '%23')}?immutable=1`;
  return new Database(uri, { readonly: true });
}

export function readLedgers(dashboardDb: string): LedgerInfo[] {
  const db = openReadonly(dashboardDb);
  try {
    return db
      .query("SELECT name, ledgerId, tenantId FROM Ledgers WHERE name LIKE '%julian-chat%' ORDER BY createdAt")
      .all() as LedgerInfo[];
  } finally {
    db.close();
  }
}

export function readKeys(d1Db: string, ledgerId: string): string[] {
  const db = openReadonly(d1Db);
  try {
    return (db.query('SELECT key FROM KeyByTenantLedger WHERE ledger = ?').all(ledgerId) as Array<{ key: string }>).map(
      (r) => r.key,
    );
  } finally {
    db.close();
  }
}

export function readBlobs(r2Db: string, ledgerId: string): Array<{ blobId: string; uploaded: number; key: string }> {
  const db = openReadonly(r2Db);
  try {
    return db
      .query("SELECT blob_id AS blobId, uploaded, key FROM _mf_objects WHERE key LIKE '%/' || ? || '/car/%' ORDER BY uploaded, blob_id")
      .all(ledgerId) as Array<{ blobId: string; uploaded: number; key: string }>;
  } finally {
    db.close();
  }
}
