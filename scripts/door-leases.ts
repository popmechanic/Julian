#!/usr/bin/env bun
// scripts/door-leases.ts — break-glass administration of gate leases:
// list / revoke / export against the gate's /leases* faces.
//
// Authenticates with GATE_BREAKGLASS_SECRET, sourced from the Mac .env only
// inside this command (mail discipline rule 5: scope the secret, never as
// ambient session state) — e.g. `source .env && bun scripts/door-leases.ts list`.
//
// This is a break-glass admin tool, not a door — it authenticates with the
// shared secret above, never with a lease token (the gate's /leases* face
// doesn't accept one; Global Constraints). It still honors the single
// lease-path story (JULIAN_LEASE_FILE, same resolver door-knock.ts and the
// lease client use) for one purpose: telling the operator where a door's
// local lease file lives when they've just revoked it, so they know what to
// clean up on that machine.

import { resolveLeasePath } from './lib/lease-client';

interface Lease {
  leaseId: string;
  doorName: string;
  scope: string;
  status: string;
  born: number;
  lastRenewal: number | null;
  lastVerb: string | null;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function pad(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width);
}

function renderTable(leases: Lease[]): string {
  const header = pad('door_name', 28) + pad('scope', 14) + pad('status', 16) + 'born';
  const rows = leases.map(
    (l) => pad(l.doorName, 28) + pad(l.scope, 14) + pad(l.status, 16) + new Date(l.born).toISOString(),
  );
  return [header, ...rows].join('\n');
}

/** The gate answers `GET /leases` with `{"leases": [...]}` (Global Constraints);
 *  a bare array is tolerated defensively in case that ever changes. */
export function parseLeasesBody(text: string): Lease[] {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed as Lease[];
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { leases?: unknown }).leases)) {
    return (parsed as { leases: Lease[] }).leases;
  }
  throw new Error(`unexpected /leases response shape: ${text}`);
}

export async function fetchLeaseList(baseUrl: string, secret: string): Promise<Lease[]> {
  const res = await fetch(`${trimSlash(baseUrl)}/leases`, { headers: { 'X-Breakglass-Secret': secret } });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return parseLeasesBody(text);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  const brokerUrl = process.env.BROKER_URL;
  const secret = process.env.GATE_BREAKGLASS_SECRET;
  if (!brokerUrl) {
    console.error('BROKER_URL not set.');
    process.exit(2);
  }
  if (!secret) {
    console.error('GATE_BREAKGLASS_SECRET not set — source .env for this command only, then retry.');
    process.exit(2);
  }
  const base = trimSlash(brokerUrl);
  const headers = { 'X-Breakglass-Secret': secret };

  if (cmd === 'list') {
    let leases: Lease[];
    try {
      leases = await fetchLeaseList(base, secret);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    console.log(renderTable(leases));
    return;
  }

  if (cmd === 'revoke') {
    const doorName = rest[0];
    if (!doorName) {
      console.error('usage: bun scripts/door-leases.ts revoke <door_name>');
      process.exit(2);
    }
    const res = await fetch(`${base}/leases/revoke`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ door_name: doorName }),
    });
    const text = await res.text();
    console.log(text);
    if (!res.ok) process.exit(1);
    console.error(
      `if ${doorName} was this machine's own door, its local lease file is now dead — ` +
        `clear it: rm ${resolveLeasePath(process.env)}`,
    );
    return;
  }

  if (cmd === 'export') {
    const res = await fetch(`${base}/leases/export`, { headers });
    const text = await res.text();
    console.log(text);
    if (!res.ok) process.exit(1);
    return;
  }

  console.error('usage: bun scripts/door-leases.ts <list|revoke <door_name>|export>');
  process.exit(2);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`door-leases failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
