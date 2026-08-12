import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateManifest } from './package-manifest';

function repoFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pkg-manifest-'));
  writeFileSync(join(root, 'AGENT.md'), '# AGENT\n');
  writeFileSync(join(root, 'catalog.md'), '# Catalog\n');
  mkdirSync(join(root, 'soul'));
  writeFileSync(join(root, 'soul', '01-naming.md'), 'naming\n');
  mkdirSync(join(root, 'memory'));
  writeFileSync(join(root, 'memory', 'mail-journal.md'), 'PRIVATE\n');
  writeFileSync(join(root, 'package-manifest.json'), '{"stale": true}');
  writeFileSync(join(root, 'package-allowlist.json'), JSON.stringify({
    include: ['AGENT.md', 'catalog.md', 'soul/**'],
  }));
  return root;
}

describe('generateManifest', () => {
  test('walks the allowlist, hashes files, sorts, and excludes itself', async () => {
    const root = repoFixture();
    const manifest = await generateManifest(root, 'f'.repeat(40));
    expect(manifest.generatedFrom).toBe('f'.repeat(40));
    expect(manifest.files.map((f) => f.path)).toEqual(['AGENT.md', 'catalog.md', 'soul/01-naming.md']);
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(manifest.files.every((f) => f.bytes > 0)).toBe(true);
    // N3: the manifest never lists itself; the excluded journal never appears.
    expect(manifest.files.some((f) => f.path === 'package-manifest.json')).toBe(false);
    expect(manifest.files.some((f) => f.path.includes('mail-journal'))).toBe(false);
  });

  test('writing is deterministic: same tree, same JSON (modulo generatedAt)', async () => {
    const root = repoFixture();
    const a = await generateManifest(root, 'f'.repeat(40));
    const b = await generateManifest(root, 'f'.repeat(40));
    expect(a.files).toEqual(b.files);
  });
});
