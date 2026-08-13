import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Smoke check: verify the app bundle includes the required environment URLs.
 *
 * Vite bakes VITE_* values into the bundle at build time. This script verifies
 * that VITE_SYNC_URL and VITE_GATE_URL made it into the built bundle — catching
 * the otherwise-silent failure where a bundle built without .env exists,
 * connects to claude 401, and says nothing.
 *
 * Usage:
 *   bun scripts/verify-app-bundle.ts [syncUrl] [gateUrl]
 *
 * If syncUrl/gateUrl not provided, reads from .env.
 */

function readEnv(varName: string): string | null {
  try {
    const envFile = readFileSync('.env', 'utf-8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(varName + '=')) {
        const value = trimmed.slice(varName.length + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          return value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    // .env doesn't exist or can't be read
  }
  return null;
}

function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // If URL parsing fails, return the original string
    // (this allows for relative URLs or other formats)
    return url;
  }
}

async function main() {
  // Get sync and gate URLs from arguments or .env
  let syncUrl = process.argv[2] || readEnv('VITE_SYNC_URL');
  let gateUrl = process.argv[3] || readEnv('VITE_GATE_URL');

  if (!syncUrl) {
    console.error('BUNDLE SMOKE FAILED: built without VITE_SYNC_URL — the app cannot sync');
    process.exit(1);
  }

  if (!gateUrl) {
    console.error('BUNDLE SMOKE FAILED: built without VITE_GATE_URL — the app cannot exchange');
    process.exit(1);
  }

  // Extract hostnames for grepping
  const syncHost = extractHostname(syncUrl);
  const gateHost = extractHostname(gateUrl);

  // Read all .js files in app/dist/assets/
  const assetsDir = resolve('app/dist/assets');
  let jsFiles: string[] = [];

  try {
    const files = readdirSync(assetsDir);
    jsFiles = files.filter(f => f.endsWith('.js'));
  } catch (err) {
    console.error(`BUNDLE SMOKE FAILED: app/dist/assets not found or not readable`);
    process.exit(1);
  }

  if (jsFiles.length === 0) {
    console.error(`BUNDLE SMOKE FAILED: no .js files found in app/dist/assets`);
    process.exit(1);
  }

  // Check each JS file for the required hostnames
  let syncFound = false;
  let gateFound = false;

  for (const jsFile of jsFiles) {
    const filePath = join(assetsDir, jsFile);
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.includes(syncHost)) {
        syncFound = true;
      }
      if (content.includes(gateHost)) {
        gateFound = true;
      }
      if (syncFound && gateFound) break;
    } catch (err) {
      console.error(`BUNDLE SMOKE FAILED: could not read ${jsFile}`);
      process.exit(1);
    }
  }

  if (!syncFound) {
    console.error(`BUNDLE SMOKE FAILED: built without VITE_SYNC_URL (${syncHost}) — the app cannot sync`);
    process.exit(1);
  }

  if (!gateFound) {
    console.error(`BUNDLE SMOKE FAILED: built without VITE_GATE_URL (${gateHost}) — the app cannot exchange`);
    process.exit(1);
  }

  console.log(`✓ bundle smoke check: sync=${syncHost}, gate=${gateHost}`);
}

main().catch(err => {
  console.error('BUNDLE SMOKE FAILED:', err.message);
  process.exit(1);
});
