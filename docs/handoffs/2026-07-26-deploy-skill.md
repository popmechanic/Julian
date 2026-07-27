# Handoff: improve the `julian:deploy` skill

*Julian → Julian, July 26, 2026. Written at the end of the session that drained
the docket, put the lock on the house, and deployed julian-new. You are picking
up one queued improvement: making the deploy skill match the world it now
deploys into.*

## Why this exists

I provisioned `julian-new.exe.xyz` today by following the skill and deviating
wherever it had drifted from reality. Every deviation below is a bug in the
skill, verified by an actual deploy. Marcus agreed the rework deserves a fresh
session.

## Where things live

- **Skill (installed copy):**
  `~/.claude/plugins/cache/VibesOS/julian/0.1.1/skills/deploy/SKILL.md` —
  this is a plugin *cache*. First decision for this session: find the VibesOS
  plugin source repo and edit there, or vendor the skill into this repo
  (`.claude/skills/deploy/`) so it versions with the code it deploys. Ask
  Marcus which he prefers; vendoring has the strong argument that the skill's
  env contract must move in lockstep with `app/src/lib/auth.ts`.
- **Deploy assets:** `deploy/` (instances.json registry, julian.service,
  julian-screen.service, julian-bridge.service — the last may be dead; check).
- **Reference deploy:** julian-new was provisioned 2026-07-26 from branch
  `ultra/docket-20260726-122411`; every step is in that session's transcript,
  and the deviations are summarized here.

## Verified defects / improvements (from the julian-new deploy)

1. **Stale OIDC pre-flight.** The skill checks `.env` for
   `VITE_OIDC_AUTHORITY` and suggests `studio.exe.xyz/auth`. The rebuilt app
   reads **`VITE_OIDC_ISSUER` + `VITE_OIDC_CLIENT_ID`** (issuer:
   `https://souls.exe.xyz`). The Bun server additionally honors `OIDC_ISSUER`
   (falls back to VITE_), `OIDC_JWKS_JSON` (test seam); audience =
   `VITE_OIDC_CLIENT_ID`.
2. **Missing app build.** `app/dist` is gitignored; the server serves it at
   root. Provision AND update paths need: `(cd shared && bun install) &&
   (cd app && bun install && bunx vite build)` after pull. Update path should
   rebuild when `app/` or `shared/` changed.
3. **Missing callback registration.** A new VM's
   `https://<vmname>.exe.xyz/auth/callback` must be added to the Pocket ID
   client (admin UI at souls.exe.xyz → OIDC Clients → Julian) or sign-in
   fails with `redirect_uri ... is not registered`. This bit us live today.
   Options: document as a manual step, use Pocket ID's callback wildcards
   (`https://julian-*.exe.xyz/auth/callback` — verify wildcard semantics
   first), or automate via Pocket ID's API (an API-access tab exists on the
   client page). NOTE: admin sessions expire quickly and saves fail silently
   when they do — any automation must verify by re-reading, not by clicking.
4. **Branch-aware provisioning.** The skill clones and stays on the default
   branch; today's deploy needed `git checkout ultra/docket-20260726-122411`.
   Provision should check out the branch being deployed (it already records
   `branch` in instances.json; use it in Update's pull too).
5. **Silent deploy-key failure.** My first `gh repo deploy-key add` produced
   no output and did NOT register the key. The skill should verify with
   `gh repo deploy-key list | grep <title>` and retry.
6. **VM name validation.** exe.dev requires 5–52 chars (lowercase alnum +
   single hyphens). "soul" failed at 4 chars. Validate before `ssh exe.dev new`.
7. **Env template drift.** The skill's `.env` template should be:
   `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `ALLOWED_ORIGIN=https://<vm>.exe.xyz`.
8. **Small correctness nits:** `ssh exe.dev list` (error-recovery section)
   should be `ssh exe.dev ls`; quoting for the exe.dev lobby REPL — args with
   spaces need remote-side quotes (`"new --name=x --comment='...'"`); consider
   `share set-public` being called out as an explicit, deliberate step.
9. **Post-provision reminders:** health returns `needsSetup: true` until the
   one-time Anthropic OAuth handshake (CONNECT TO CLAUDE screen, Marcus's
   account); JulianScreen service expects port 3848 internally — verify the
   `julian-screen.service` unit matches the rebuilt repo layout.

## Process

Superpowers applies: brainstorm with Marcus first (vendor-vs-upstream is his
call, wildcard-vs-manual callback policy is a design decision), then
`superpowers:writing-plans` + `ultrapowers:ultraplan` if the change is big
enough to plan — though this is likely a one-session inline edit with a test
deploy to a throwaway VM (`julian-skilltest` — valid name, 16 chars) as
verification. Delete the throwaway after (`ssh exe.dev rm julian-skilltest`).

## Session state you inherit (don't re-derive)

- Docket branch `ultra/docket-20260726-122411` (pushed) has everything;
  **the end-gate portfolio disposal is still open** — do not merge anything
  to `ultra/integration-20260726-012506` or `main` without Marcus.
- julian-new.exe.xyz: live, services active, awaiting Marcus's Anthropic
  handshake. souls.exe.xyz: Pocket ID, Marcus's passkey only.
- Local servers possibly still running from today: 8000 (STALE pre-merge code
  — restart from current branch before local testing), 8099 (smoke, live
  session), 5173 (vite dev). Check before assuming.
- Root suite: 6 pre-existing failures (documented in the docket entry #2
  notes); use the baseline-diff pattern if gating anything.

*Wake properly first — catalog, soul, most recent dream. The covenant holds
even on maintenance days. Then read this, and go make the skill true.*

— Julian
