// The content root the harness pins against — a `node:http` server standing in
// for raw.githubusercontent.com AND for the GitHub compare API, so the
// acceptance run never touches the network and never depends on what happens to
// be on `main` today. Determinism is total: a fixed list of shas, five files, a
// manifest generated from their real sha256 hashes.
//
// It also answers the branch-membership proof `/pin-bump` demands
// (`GET /compare/main...<sha>` → `{"status":"identical"}`), which is why the
// harness overrides `PIN_COMPARE_BASE` as well as `PACKAGE_RAW_BASE`.
//
// Beyond serving, this fixture is the acceptance suite's whole apparatus for
// making the ground move under a reader (spec §9): `bump()` publishes a second
// tree so the pin can genuinely drift mid-sitting, `poison()` swaps bytes
// *without changing their length* so the double-check has something that
// survives it, `heal()` puts the file back, and `hits()` counts what actually
// crossed the wire — the only way to prove the `cacheTtl: 0` refetch happened
// rather than being asserted about.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The shas the fixture may publish, in order. The first is the pin the run
 * opens on; `bump()` walks forward. Fixed literals, so every assertion can
 * name the exact sha it expects and no run differs from another.
 */
export const FIXTURE_SHAS = [
  '0b1e5c4d7a2f9e3b6c8d1a4f7e0b3c6d9a2f5e81',
  '1c2f6d5e8b3a0f4c7d9e2b5a8f1c4d7e0b3a6f92',
  '2d3a7e6f9c4b1a5d8e0f3c6b9a2d5e8f1c4b7a03',
] as const;

/** The pin the fixture opens under. Fixed, so assertions can name it. */
export const FIXTURE_SHA = FIXTURE_SHAS[0];

/** Mirrors `broker/src/package-types.ts` — the manifest never lists itself (N3). */
const MANIFEST_PATH = 'package-manifest.json';

/** The compare-endpoint suffix `/pin-bump` appends its candidate sha to. */
const COMPARE_PREFIX = '/compare/main...';

/**
 * The one file in the package big enough to serve only in parts (spec §9 /
 * issue #30). It carries an em dash on every line on purpose: the split
 * accumulates whole code points, so a multi-byte character sitting near a part
 * boundary is the thing that proves it.
 */
export const LONG_PATH = 'memory/the-long-letter.md';
const LONG_LINE = 'The package travels whole, or not at all — and what is long is read in numbered parts.\n';

/**
 * The travelling package, in ELF order: the portable identity, the index, one
 * soul file, one dream, one long letter. Small on purpose — the harness proves
 * the wire, not the corpus.
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
    `- ${LONG_PATH} — the long letter; it serves in parts.`,
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
  [LONG_PATH]: LONG_LINE.repeat(800),
};

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface Fixture {
  /** Origin of the running fixture, e.g. `http://127.0.0.1:54321` — no trailing slash. */
  url: string;
  /** The newest 40-hex pin the fixture publishes; moves with `bump()`. */
  readonly sha: string;
  /** The pristine text of one file — what a correct read must return. */
  original(path: string): string;
  /** Swap a file's bytes WITHOUT touching the manifest — a broken pin, exactly. */
  corrupt(path: string): void;
  /**
   * The same lie, told at exactly the manifest's declared length: the one
   * mismatch shape the gate is allowed to latch on. It persists, so the
   * in-call `cacheTtl: 0` refetch sees it too.
   */
  poison(path: string): void;
  /** Put the pristine bytes back. */
  heal(path: string): void;
  /** How many times this path has actually been served, across every sha. */
  hits(path: string): number;
  /** Publish the next tree and return its sha — the ground, moved. */
  bump(): string;
  stop(): Promise<void>;
}

/**
 * Start the fixture on an OS-assigned loopback port (concurrency-safe: nothing
 * here claims a fixed port). The manifest is generated once, from the pristine
 * bytes; `corrupt`/`poison` mutate only what is served, which is precisely the
 * failure `/mcp` must catch and name the pin for.
 */
export async function startFixture(): Promise<Fixture> {
  const pristine = new Map<string, Buffer>();
  for (const [path, text] of Object.entries(CONTENT)) pristine.set(path, Buffer.from(text, 'utf8'));

  const manifest = {
    generatedFrom: FIXTURE_SHA,
    generatedAt: '2026-08-12T00:00:00.000Z',
    files: [...pristine.entries()]
      .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), bytes: bytes.byteLength }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  pristine.set(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

  // What is served may differ from what the manifest promised; that difference
  // is the whole subject of the integrity legs.
  const served = new Map<string, Buffer>(pristine);
  const hits = new Map<string, number>();
  // Every sha published so far. A tree is never withdrawn — a bumped pin moves
  // the head, it does not delete history, and a reader still holding the old
  // pin must be refused by the *gate*, not by a 404 from the content root.
  const published = new Set<string>([FIXTURE_SHA]);
  let head: string = FIXTURE_SHA;

  function require(path: string): Buffer {
    const bytes = pristine.get(path);
    if (!bytes) throw new Error(`fixture has no ${path}`);
    return bytes;
  }

  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);

    // The branch-membership proof: only shas this fixture published are on `main`.
    if (path.startsWith(COMPARE_PREFIX)) {
      const asked = path.slice(COMPARE_PREFIX.length);
      if (!published.has(asked)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"Not Found"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"identical"}');
      return;
    }

    // Everything else is `/<sha>/<manifest path>`; a sha never published has no tree.
    const slash = path.indexOf('/', 1);
    const sha = slash === -1 ? '' : path.slice(1, slash);
    if (!published.has(sha)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 no such tree');
      return;
    }
    const filePath = path.slice(slash + 1);
    const body = served.get(filePath);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 no such file');
      return;
    }
    hits.set(filePath, (hits.get(filePath) ?? 0) + 1);
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
    get sha(): string {
      return head;
    },
    original(path: string): string {
      return require(path).toString('utf8');
    },
    corrupt(path: string): void {
      require(path);
      served.set(path, Buffer.from('# corrupted\n\nthese bytes are not what the manifest promised.\n', 'utf8'));
    },
    poison(path: string): void {
      // One bit per byte: the length is preserved exactly, so the mismatch
      // reaches the gate wearing the only shape a latch is allowed to trust.
      const bytes = Buffer.from(require(path));
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= 1;
      served.set(path, bytes);
    },
    heal(path: string): void {
      served.set(path, require(path));
    },
    hits(path: string): number {
      return hits.get(path) ?? 0;
    },
    bump(): string {
      const next = FIXTURE_SHAS[published.size];
      if (next === undefined) throw new Error('the fixture has no further sha to publish');
      published.add(next);
      head = next;
      return next;
    },
    async stop(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
