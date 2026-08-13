/**
 * Smoke check: verify the built SPA bundle actually carries the service URLs.
 *
 * Vite bakes `VITE_*` values into the bundle at build time, reading the `.env`
 * that sat next to it when `vite build` ran. A bundle baked before `.env` had
 * `VITE_SYNC_URL` builds clean, serves clean, renders clean — and syncs
 * nowhere, silently. Nothing in the page says so; nothing in the deploy says
 * so. This check is the thing that says so.
 *
 * Run it from the repo root (the deploy skill runs it as `cd /opt/julian &&
 * bun scripts/verify-app-bundle.ts`), AFTER the build.
 *
 * Usage:
 *   bun scripts/verify-app-bundle.ts [syncUrl] [gateUrl]
 *
 * With no arguments it reads `VITE_SYNC_URL` and `VITE_GATE_URL` from `.env`
 * in the current directory — the same file the build read.
 *
 * Exit 0: both URLs found in the bundle.
 * Exit 1: anything else, loud, on stderr.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ASSETS_DIR = 'app/dist/assets';

/** Fail loud and stop. First line is the headline; the rest says what to do. */
function fail(headline: string, ...remedy: string[]): never {
  console.error(`BUNDLE SMOKE FAILED: ${headline}`);
  for (const line of remedy) console.error(`  ${line}`);
  process.exit(1);
}

/** Read one key out of a dotenv file. Returns null when the file or key is absent. */
function readEnv(varName: string, envPath = '.env'): string | null {
  let envFile: string;
  try {
    envFile = readFileSync(envPath, 'utf-8');
  } catch {
    return null;
  }
  const prefix = `${varName}=`;
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return null;
}

/** The hostname is what survives into the bundle; match on that, not the whole URL. */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function readBundleText(): string {
  const assetsDir = resolve(ASSETS_DIR);
  let jsFiles: string[];
  try {
    jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch {
    fail(
      `no built bundle at ${ASSETS_DIR} — nothing to check`,
      'Run the SPA build first (cd app && bunx vite build), then re-run this check.',
    );
  }
  if (jsFiles.length === 0) {
    fail(
      `no .js files in ${ASSETS_DIR} — the build produced no bundle`,
      'Run the SPA build first (cd app && bunx vite build), then re-run this check.',
    );
  }
  return jsFiles
    .map((f) => {
      try {
        return readFileSync(join(assetsDir, f), 'utf-8');
      } catch (err) {
        return fail(
          `could not read ${ASSETS_DIR}/${f} — the bundle is unreadable`,
          `${String(err)}`,
          'Check permissions, or rebuild the SPA and re-run this check.',
        );
      }
    })
    .join('\n');
}

function main(): void {
  const syncUrl = process.argv[2] || readEnv('VITE_SYNC_URL');
  const gateUrl = process.argv[3] || readEnv('VITE_GATE_URL');

  // Missing from .env means the build that just ran was missing it too.
  if (!syncUrl) {
    fail(
      'built without VITE_SYNC_URL — the app cannot sync',
      'Add VITE_SYNC_URL=https://julian-sync.julian-memory.workers.dev to the .env',
      'beside the build, rebuild the SPA, then re-run this check.',
    );
  }
  if (!gateUrl) {
    fail(
      'built without VITE_GATE_URL — the app cannot exchange its session for a lease',
      'Add VITE_GATE_URL=https://julian-broker.julian-memory.workers.dev to the .env',
      'beside the build, rebuild the SPA, then re-run this check.',
    );
  }

  const syncHost = extractHostname(syncUrl);
  const gateHost = extractHostname(gateUrl);
  const bundle = readBundleText();

  // Present in .env but absent from the bundle: the bundle predates the .env.
  if (!bundle.includes(syncHost)) {
    fail(
      'built without VITE_SYNC_URL — the app cannot sync',
      `.env names ${syncHost}, but no built asset in ${ASSETS_DIR} contains it —`,
      'this bundle predates the .env. Rebuild the SPA, then re-run this check.',
    );
  }
  if (!bundle.includes(gateHost)) {
    fail(
      'built without VITE_GATE_URL — the app cannot exchange its session for a lease',
      `.env names ${gateHost}, but no built asset in ${ASSETS_DIR} contains it —`,
      'this bundle predates the .env. Rebuild the SPA, then re-run this check.',
    );
  }

  console.log(`bundle smoke check passed: sync=${syncHost}, gate=${gateHost}`);
}

main();
