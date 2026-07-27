#!/usr/bin/env bun
// deploy/pocketid-register-callback.ts
// Register https://<vmname>.exe.xyz/auth/callback with the Pocket ID OIDC client,
// then RE-READ the client config and succeed only if the callback is really there.
// Pocket ID admin sessions expire quickly and saves can fail silently — never
// trust the write, only the re-read.
// Exit codes: 0 = callback verified present; 3 = no API key (manual step printed); 1 = failure.

const vmname = process.argv[2];
if (!vmname) {
  console.error("usage: bun deploy/pocketid-register-callback.ts <vmname>");
  process.exit(1);
}

const issuer = (process.env.POCKETID_ISSUER || process.env.VITE_OIDC_ISSUER || "").replace(/\/+$/, "");
const clientId = process.env.POCKETID_CLIENT_ID || process.env.VITE_OIDC_CLIENT_ID || "";
const apiKey = process.env.POCKETID_API_KEY || "";
const callback = `https://${vmname}.exe.xyz/auth/callback`;

if (!issuer || !clientId) {
  console.error("Missing VITE_OIDC_ISSUER / VITE_OIDC_CLIENT_ID — run `source .env` first.");
  process.exit(1);
}

if (!apiKey) {
  console.error(`No POCKETID_API_KEY set. Manual step required:
  1. Open ${issuer} (Pocket ID admin) -> OIDC Clients -> Julian
  2. Add callback URL: ${callback}
  3. Save, then RE-OPEN the client and confirm the URL is still listed
     (admin sessions expire quickly and saves fail silently).`);
  process.exit(3);
}

const base = `${issuer}/api/oidc/clients/${clientId}`;
const headers = { "X-API-KEY": apiKey, "Content-Type": "application/json" };

async function getClient(): Promise<any> {
  const res = await fetch(base, { headers });
  if (!res.ok) {
    console.error(`GET client failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

const before = await getClient();
const urls: string[] = before.callbackURLs ?? [];

if (!urls.includes(callback)) {
  const res = await fetch(base, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...before, callbackURLs: [...urls, callback] }),
  });
  if (!res.ok) {
    console.error(`PUT client failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  // verify by re-read — the write's 200 proves nothing
  const after = await getClient();
  if (!(after.callbackURLs ?? []).includes(callback)) {
    console.error(`FAIL: ${callback} missing after write — the save did not stick.`);
    process.exit(1);
  }
}

console.log(`OK: ${callback} registered with ${issuer} (verified by re-read)`);
process.exit(0);
