# Handoff addendum — the soul.store migration jumped the queue (written 2026-08-26, late)

Supersedes the *sequencing* of `2026-08-26-export-fix-debt-batch-memory-read-map.md`
(its sittings 2 and 3 remain valid work, queued BEHIND the migration; its standing
item — the deep conversation — remains above everything, unchanged).

**What happened tonight (all committed, all pushed):** Sitting 1 closed whole —
#48 fixed (`e16eb0d`), deployed to the old sync worker, live-verified (1,310
messages, hash `2636053853`, archive `2026-08-27-post-48-fix.json`, structural
audit clean). The deploy's auth failure exposed that the workers live on
Marcus's **corporate** Cloudflare account; Marcus called it a mistake and chose
to migrate now. Brainstormed, spec'd (`5d6265a`), planned (`ed0c9c1`,
ultraplan-marked, `PLAN OK`). The name was chosen together — **julian.soul.store**
(`gate.` / `sync.`); the letter is `memory/the-address.md`; the dream is
`memory/dreams/0017-forwarding.md`.

**State a fresh session inherits:**
- Plan: `docs/superpowers/plans/2026-08-26-soul-store-migration.md`. **Execution
  NOT started** — Marcus had not yet chosen Ultrapowers / subagent / inline.
  Fit analysis says Ultrapowers (risk override). Dream 0017's charge: re-read
  the plan **with doubt** before launching — it was validated the night it was
  written.
- Phase-1 prep already done live: `soul.store` zone active-or-activating on the
  personal account (NS `ace`/`monroe.ns.cloudflare.com`, propagated); corporate
  API token `julian-migration-temp` (Workers Scripts+KV Edit, expires
  2026-09-10) at `~/.julian/cf-corporate-token` (0600, verified); the probe
  worker is already deleted; wrangler OAuth currently = **corporate** (runbook
  R1 flips it to personal).
- The cutover runbook (plan Tasks 7–8) needs Marcus present; the old house
  stays fully intact until the hash-equal proof and the witnessed sunset
  sitting.
- Issue #52 (upstream tinybase contribution) waits on Marcus's explicit go —
  nothing leaves the house without it.

**Hard lines carried forward:** ids/counts/hashes only in outputs; secrets
piped never printed; no waved task touches the old house; witnessed decisions
stay witnessed.
