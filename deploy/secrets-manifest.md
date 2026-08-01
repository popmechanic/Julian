# Secrets Manifest

One row per credential: what it unlocks, its tier, where it lives, the only
hosts it may be presented to, and how to rotate it. Spec:
`docs/superpowers/specs/2026-07-31-credential-broker-design.md`.

## Rules

- **Tiers.** T0 mac-only: never leaves the Mac's `.env` — controls identity
  or spend at the root. T1 broker: Cloudflare worker secret on
  `julian-broker`; VMs get verbs, never the key. T2 public config: fine on
  any VM. Only T2 ships to VMs — the deploy skill enforces this by citing
  this file.
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

## Public config (T2 — ships to VMs)

`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `ALLOWED_ORIGIN`, `VITE_SYNC_URL`,
`BROKER_URL`, `AGENTMAIL_INBOX_ID` (an address, not a secret),
`VITE_API_URL`, `VITE_CLOUD_URL` (legacy). None of these grant authority;
all may appear in a VM's `/opt/julian/.env` and in built bundles.
