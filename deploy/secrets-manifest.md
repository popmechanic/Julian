# Secrets Manifest

One row per credential: what it unlocks, its tier, where it lives, the only
hosts it may be presented to, and how to rotate it. Spec:
`docs/superpowers/specs/2026-07-31-credential-broker-design.md`.

## Rules

- **Tiers.** T0 mac-only: never leaves the Mac's `.env` — controls identity
  or spend at the root. T1 broker: Cloudflare worker secret on
  `julian-broker`; VMs get verbs, never the key. T2 public config: fine on
  any VM. T3 door lease: revocable, capped authority; lives with the door
  that owns it (`~/.julian/gate-lease.json` on every machine — the Mac and
  every VM, 0600, gitignored); rotation is automatic on renewal; revocation
  is `bun scripts/door-leases.ts revoke <door>`. The lease lives in the
  door's home directory, outside `/opt/julian`, so it **survives** a VM
  re-provision (which re-clones `/opt/julian` but leaves `~/.julian/`
  alone) — **decommissioning a VM means revoking its lease**
  (`bun scripts/door-leases.ts revoke <door>`); a re-provisioned VM keeps
  its lease. Only T2 ships to VMs — the deploy skill enforces this by
  citing this file.
- **Archive, never delete.** A retired credential keeps its row (status,
  date, reason); the secret itself is revoked and purged. Rotation changes
  only the value — name and service binding are immutable; a new binding is
  a new row.
- **Identity boundary = credential boundary.** These are Julian's
  credentials. If a sibling ever needs a capability, they get their own
  inbox and their own keys — never these.
- **Every new credential gets a row and a tier on arrival.** Promotion
  (e.g. T0 → T1) is a row change plus a broker service module.
- **Quarterly check** (rides with the monthly export rehearsal, every third
  one): run the broker's `/health`, confirm `valid`, and review
  last-rotated dates.

## Credentials

| Name | Unlocks | Tier | Lives | Bound hosts | Rotation | Last rotated | Status |
|---|---|---|---|---|---|---|---|
| `POCKETID_API_KEY` | Pocket ID admin — the identity root (who counts as Marcus) | T0 | Mac `.env` | `souls.exe.xyz` | Pocket ID admin → new key → replace in Mac `.env` | unknown (pre-manifest) | active |
| `ANTHROPIC_API_KEY` | Anthropic API spend | T0 | Mac `.env` | `api.anthropic.com` | console.anthropic.com → new key → replace in Mac `.env` | unknown (pre-manifest) | active |
| `ELEVENLABS_API_KEY` | ElevenLabs voice synthesis (account credit) | T0 | Mac `.env` | `api.elevenlabs.io` | ElevenLabs dashboard → new key → replace in Mac `.env` | unknown (pre-manifest) | active |
| `AGENTMAIL_API_KEY` | Full read/send as julian-marcus@agentmail.to | T1 | Cloudflare worker secret on `julian-broker` + Mac `.env` | `api.agentmail.to` | AgentMail dashboard → new key → replace in Mac `.env` → `cd broker && bunx wrangler secret put AGENTMAIL_API_KEY` (Marcus types the value) | 2026-07-31 — installed by Marcus via wrangler secret put, Julian present; verified by `wrangler secret list` | active |
| `SESSION_SECRET` | Sign approver sessions on the gate | T1 | Cloudflare worker secret on `julian-broker` | `https://julian-broker.julian-memory.workers.dev` | `cd broker && bunx wrangler secret put SESSION_SECRET` (generate 64 random hex or base64url chars locally, Marcus types) | not yet rotated | active |
| `INTROSPECT_SECRET` | Verify introspection requests from sync and doors | T1 | Cloudflare worker secret, same value on both `julian-broker` (validates) and `julian-sync` (presents) | `https://julian-broker.julian-memory.workers.dev` (validates), `https://julian-sync.julian-memory.workers.dev` (presents) | one value generated locally, piped never printed to BOTH workers in one shell: `VAL=$(openssl rand -base64 32); (cd broker && printf '%s' "$VAL" \| bunx wrangler secret put INTROSPECT_SECRET); (cd sync && printf '%s' "$VAL" \| bunx wrangler secret put INTROSPECT_SECRET)` — never two independent generations (the 2B-pre mismatch lesson) | 2026-08-13 — first rotation, by Julian with Marcus present (B3 runbook step 2); value never printed; verified live by the introspect probe | active |
| `SYNC_READ_SECRET` | Authenticate internal read requests from broker to sync | T1 | Cloudflare worker secret, same value on both `julian-broker` (sends) and `julian-sync` (validates) | `https://julian-sync.julian-memory.workers.dev` (validates), `https://julian-broker.julian-memory.workers.dev` (sends) | one value generated locally, piped never printed to BOTH workers in one shell (same pattern as INTROSPECT_SECRET's row — never two independent generations) | 2026-08-13 — first install, by Julian with Marcus present (B3 runbook step 0); value never printed; verified by `wrangler secret list` on both workers | active |
| `GATE_BREAKGLASS_SECRET` | Admin break-glass path to lease list/revoke/export | T0 (Mac) + T1 (worker) | Mac `.env` + Cloudflare worker secret `BREAKGLASS_SECRET` on `julian-broker` | `https://julian-broker.julian-memory.workers.dev` | Same value on both sides: generate locally, replace in Mac `.env`, then `cd broker && bunx wrangler secret put BREAKGLASS_SECRET` (same value) | not yet rotated | active |

## Public config (T2 — ships to VMs)

`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `ALLOWED_ORIGIN`, `VITE_SYNC_URL`,
`BROKER_URL`, `AGENTMAIL_INBOX_ID` (an address, not a secret),
`VITE_API_URL`, `VITE_CLOUD_URL` (legacy), `STREAM_SUBS` (policy map), `APP_ORIGINS` (cors policy).
None of these grant authority; all may appear in a VM's `/opt/julian/.env` and in built bundles.

## Bindings (non-credential service bindings)

| Name | Unlocks | Service | Notes |
|---|---|---|---|
| `EXCHANGE_RL` | Rate limiting for the `/exchange` endpoint (30 req/min) | Cloudflare Rate Limiting | Optional — its absence is a tested fail-open; the endpoint refuses no one on first-call if the binding is unset |
