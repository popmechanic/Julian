// scripts/stream-import-fireproof.test.ts — the CLI's discipline, proven without
// ever touching the real archive: temp-dir safety, manifest verification, and the
// refusals. No real message text, no real keys, no network.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSafeTmp, verifyAgainstManifest, withTempDir } from './lib/fireproof-archive';
import { assertNoFrameViolations } from './stream-import-fireproof';

describe('temp-dir discipline', () => {
  test('withTempDir removes the directory when the body throws', async () => {
    let seen = '';
    await expect(
      withTempDir(async (dir) => {
        seen = dir;
        writeFileSync(join(dir, 'k'), 'x');
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(seen.startsWith(join(tmpdir(), 'fp-import-'))).toBe(true);
    expect(existsSync(seen)).toBe(false);
  });

  test('withTempDir removes the directory on the happy path too', async () => {
    let seen = '';
    const got = await withTempDir(async (dir) => {
      seen = dir;
      writeFileSync(join(dir, 'k'), 'x');
      return 'ok';
    });
    expect(got).toBe('ok');
    expect(existsSync(seen)).toBe(false);
  });

  test('assertSafeTmp refuses $HOME and accepts /private/var/folders and /tmp', () => {
    expect(() => assertSafeTmp(join(process.env.HOME!, 'Desktop', 'fp-import-x'))).toThrow(/temp dir must not be under \$HOME/);
    expect(() => assertSafeTmp('/private/var/folders/ab/T/fp-import-x')).not.toThrow();
    expect(() => assertSafeTmp('/tmp/fp-import-x')).not.toThrow();
  });

  test('assertSafeTmp refuses a path that is under neither sanctioned root', () => {
    expect(() => assertSafeTmp('/Volumes/backup/fp-import-x')).toThrow(/must be under \/private\/var\/folders or \/tmp/);
  });
});

describe('manifest verification', () => {
  test('reports a member whose sha256 differs from the manifest line', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-manifest-'));
    writeFileSync(join(root, 'a.bin'), 'hello');
    writeFileSync(join(root, 'b.bin'), 'world');
    const shaHello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const manifest = `./a.bin  5 ${shaHello}\n./b.bin  5 ${'0'.repeat(64)}\n`;
    expect(verifyAgainstManifest(root, manifest, ['./a.bin', './b.bin'])).toEqual(['./b.bin']);
  });

  test('a member absent from the manifest is itself a mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-manifest-'));
    writeFileSync(join(root, 'a.bin'), 'hello');
    const shaHello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(verifyAgainstManifest(root, `./a.bin  5 ${shaHello}\n`, ['./a.bin', './ghost.bin'])).toEqual(['./ghost.bin']);
  });

  test('every member matching returns an empty list', () => {
    const root = mkdtempSync(join(tmpdir(), 'fp-manifest-'));
    writeFileSync(join(root, 'a.bin'), 'hello');
    const shaHello = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(verifyAgainstManifest(root, `./a.bin  5 ${shaHello}\n`, ['./a.bin'])).toEqual([]);
  });
});

describe('frame-violation post-settle check', () => {
  test('a zero count never throws', () => {
    expect(() => assertNoFrameViolations(0)).not.toThrow();
  });

  test('a positive count throws, naming the count and the limit', () => {
    expect(() => assertNoFrameViolations(2)).toThrow('frame over limit: 2 frame(s) exceeded 262144');
  });
});

describe('the CLI refuses safely', () => {
  test('missing archive → non-zero exit, no fp-import-* dir left behind, no text printed', async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith('fp-import-')).length;
    const proc = Bun.spawn(['bun', 'stream-import-fireproof.ts'], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'fp-home-')) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(err).toMatch(/archive not found|ENOENT/);
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith('fp-import-')).length).toBe(before);
  }, 30_000);

  test('an unknown flag is refused before anything is opened', async () => {
    const proc = Bun.spawn(['bun', 'stream-import-fireproof.ts', '--dump'], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'fp-home-')) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(err).toMatch(/unknown flag: --dump/);
  }, 30_000);

  test('--write without --receipt-text is refused', async () => {
    const proc = Bun.spawn(['bun', 'stream-import-fireproof.ts', '--write'], {
      cwd: import.meta.dir,
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'fp-home-')) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    expect(code).not.toBe(0);
    expect(err).toMatch(/--write requires --receipt-text/);
  }, 30_000);

  test('the script never references any backup path but the authoritative one', () => {
    const src =
      require('node:fs').readFileSync(join(import.meta.dir, 'stream-import-fireproof.ts'), 'utf8') +
      require('node:fs').readFileSync(join(import.meta.dir, 'lib', 'fireproof-archive.ts'), 'utf8');
    const hits = src.match(/julian-stream-backups[^'"`\n]*/g) ?? [];
    expect(hits).toEqual([]); // the one path lives in fireproof-types.ts as ARCHIVE_PATH
    expect(src).not.toMatch(/--dump|--show-text|--archive/);
  });
});
