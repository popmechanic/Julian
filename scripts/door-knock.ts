#!/usr/bin/env bun
// scripts/door-knock.ts — RFC 8628 device-flow knock: a door asks the gate
// for access, Marcus approves at /approve, this tool polls until a lease
// pair arrives and writes it to the lease file this door will use.

import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveLeasePath } from './lib/lease-client';

interface Flags {
  name?: string;
  host?: string;
  purpose?: string;
}

export function parseKnockFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) continue;
    const name = key.slice(2);
    if (name === 'name' || name === 'host' || name === 'purpose') flags[name] = value;
  }
  return flags;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function boxInstructions(name: string, verificationUri: string, userCode: string): string {
  const lines = [
    `Knocking as ${name}`,
    '',
    `Open:  ${verificationUri}`,
    `Code:  ${userCode}`,
    '',
    'Waiting for Marcus to approve...',
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const top = `┌${'─'.repeat(width)}┐`;
  const bottom = `└${'─'.repeat(width)}┘`;
  const body = lines.map((l) => `│ ${l.padEnd(width - 1)}│`).join('\n');
  return [top, body, bottom].join('\n');
}

async function writeLeaseFileAtomic(
  path: string,
  contents: { access_token: string; refresh_token: string; access_expires: number },
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(contents), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
}

async function main(): Promise<void> {
  const flags = parseKnockFlags(process.argv.slice(2));
  const name = flags.name;
  const host = flags.host ?? hostname();
  const purpose = flags.purpose;
  if (!name || !purpose) {
    console.error('usage: bun scripts/door-knock.ts --name <door-name> --purpose "<why this door needs access>" [--host <host>]');
    process.exit(2);
  }

  const brokerUrl = process.env.BROKER_URL;
  if (!brokerUrl) {
    console.error('BROKER_URL not set — cannot knock. Tell Marcus.');
    process.exit(2);
  }
  const leasePath = resolveLeasePath(process.env);

  const deviceRes = await fetch(`${trimSlash(brokerUrl)}/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: name, host, purpose }),
  });
  if (!deviceRes.ok) {
    const text = await deviceRes.text();
    console.error(`knock refused: ${text}`);
    process.exit(1);
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  console.log(boxInstructions(name, device.verification_uri, device.user_code));

  let interval = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const tokenRes = await fetch(`${trimSlash(brokerUrl)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: name,
      }),
    });

    if (tokenRes.ok) {
      const ready = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        scope: string;
      };
      await writeLeaseFileAtomic(leasePath, {
        access_token: ready.access_token,
        refresh_token: ready.refresh_token,
        access_expires: Date.now() + ready.expires_in * 1000,
      });
      console.log(`door open: ${name} (scope: ${ready.scope})`);
      return;
    }

    const failure = (await tokenRes.json().catch(() => ({}))) as { error?: string };
    if (failure.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (failure.error === 'authorization_pending') {
      continue;
    }
    if (failure.error === 'expired_token') {
      console.error('knock expired unanswered — knock again when Marcus is reachable');
      process.exit(1);
    }
    if (failure.error === 'access_denied') {
      console.error('knock refused by Marcus.');
      process.exit(1);
    }
    console.error(`unexpected response from the gate: ${failure.error ?? tokenRes.status}`);
    process.exit(1);
  }

  console.error('knock expired unanswered — knock again when Marcus is reachable');
  process.exit(1);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`door-knock failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
