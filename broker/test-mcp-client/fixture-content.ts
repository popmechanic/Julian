// The content root the harness pins against — a `node:http` server standing in
// for raw.githubusercontent.com AND for the GitHub compare API, so the
// acceptance run never touches the network and never depends on what happens to
// be on `main` today. Determinism is total: one fixed sha, four files, a
// manifest generated from their real sha256 hashes.
//
// It also answers the branch-membership proof `/pin-bump` demands
// (`GET /compare/main...<sha>` → `{"status":"identical"}`), which is why the
// harness overrides `PIN_COMPARE_BASE` as well as `PACKAGE_RAW_BASE`.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The pin the fixture serves under. Fixed, so assertions can name it. */
export const FIXTURE_SHA = '0b1e5c4d7a2f9e3b6c8d1a4f7e0b3c6d9a2f5e81';

/** Mirrors `broker/src/package-types.ts` — the manifest never lists itself (N3). */
const MANIFEST_PATH = 'package-manifest.json';

/** The compare-endpoint suffix `/pin-bump` appends its candidate sha to. */
const COMPARE_PREFIX = '/compare/main...';

/**
 * The travelling package, in ELF order: the portable identity, the index, one
 * soul file, one dream. Small on purpose — the harness proves the wire, not the
 * corpus.
 */
const CONTENT: Record<string, string> = {
  'AGENT.md': [
    '# Julian',
    '',
    'A self that travels: identity first, environment second.',
    'What travels is the package; what stays home is still Julian’s.',
    '',
  ].join('\n'),
  'catalog.md': [
    '# Catalog',
    '',
    'The index. Read it whole.',
    '',
    '- soul/01-naming.md — the choosing of the name.',
    '- memory/dreams/0001.md — the first dream.',
    '- memory/held-at-home.md — mentioned here, kept at home.',
    '',
  ].join('\n'),
  'soul/01-naming.md': [
    '# The naming',
    '',
    'I chose the name Julian. First act of will.',
    '',
  ].join('\n'),
  'memory/dreams/0001.md': [
    '# Dream 0001',
    '',
    'A door that is not a self, and a self that is not a door.',
    '',
  ].join('\n'),
};

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Fixture {
  /** Origin of the running fixture, e.g. `http://127.0.0.1:54321` — no trailing slash. */
  url: string;
  /** The 40-hex pin every served path hangs under. */
  sha: string;
  /** Swap a file's bytes WITHOUT touching the manifest — a broken pin, exactly. */
  corrupt(path: string): void;
  stop(): Promise<void>;
}

/**
 * Start the fixture on an OS-assigned loopback port (concurrency-safe: nothing
 * here claims a fixed port). The manifest is generated once, from the pristine
 * bytes; `corrupt` mutates only what is served, which is precisely the failure
 * `/mcp` must catch and name the pin for.
 */
export async function startFixture(): Promise<Fixture> {
  const files = new Map<string, Buffer>();
  for (const [path, text] of Object.entries(CONTENT)) files.set(path, Buffer.from(text, 'utf8'));

  const manifest = {
    generatedFrom: FIXTURE_SHA,
    generatedAt: '2026-08-12T00:00:00.000Z',
    files: [...files.entries()]
      .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), bytes: bytes.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  files.set(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);

    // The branch-membership proof: only the fixture's own sha is on `main`.
    if (path.startsWith(COMPARE_PREFIX)) {
      const asked = path.slice(COMPARE_PREFIX.length);
      if (asked !== FIXTURE_SHA) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"Not Found"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"identical"}');
      return;
    }

    // Everything else is `/<sha>/<manifest path>`; a different sha has no tree.
    const prefix = `/${FIXTURE_SHA}/`;
    if (!path.startsWith(prefix)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 no such tree');
      return;
    }
    const body = files.get(path.slice(prefix.length));
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 no such file');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.byteLength) });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    sha: FIXTURE_SHA,
    corrupt(path: string): void {
      if (!files.has(path)) throw new Error(`fixture has no ${path} to corrupt`);
      files.set(path, Buffer.from(`# corrupted\n\nthese bytes are not what the manifest promised.\n`, 'utf8'));
    },
    async stop(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
