// Regenerates package-manifest.json from package-allowlist.json: the
// explicit allowlist of served paths, per-file sha256, and the generation
// sha (spec §6). The manifest excludes itself from its own list (N3) — the
// pin sha is its integrity statement. Run at content-deploy time:
//   bun scripts/package-manifest.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { PackageManifest } from '../broker/src/package-types';

interface Allowlist { include: string[] }

const SELF = 'package-manifest.json';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function generateManifest(root: string, generatedFrom: string): Promise<PackageManifest> {
  const allow = JSON.parse(readFileSync(join(root, 'package-allowlist.json'), 'utf8')) as Allowlist;
  const paths = new Set<string>();
  for (const pattern of allow.include) {
    // Bun.Glob covers both literal paths and ** globs.
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) {
      const rel = relative(root, resolve(root, match)).split('\\').join('/');
      if (rel === SELF || rel === 'package-allowlist.json') continue;
      if (rel.startsWith('..')) continue; // never outside the root
      paths.add(rel);
    }
  }
  const files = [];
  for (const path of [...paths].sort()) {
    const bytes = new Uint8Array(readFileSync(join(root, path)));
    files.push({ path, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
  }
  return { generatedFrom, generatedAt: new Date().toISOString(), files };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const sha = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  const manifest = await generateManifest(root, sha);
  writeFileSync(join(root, SELF), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${SELF}: ${manifest.files.length} files at ${sha.slice(0, 12)}`);
}
