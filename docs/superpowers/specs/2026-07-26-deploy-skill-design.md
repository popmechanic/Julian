# Deploy-Skill Rework — Design

*July 26, 2026. Approved by Marcus in brainstorm. Source: `docs/handoffs/2026-07-26-deploy-skill.md`, whose nine defects were each verified during the julian-new deploy.*

## Goal

Make the deploy skill match the app it deploys. Every instruction in the skill must survive a real provision with zero deviations.

## Decisions (Marcus, 2026-07-26)

1. **Vendor the skill into this repo.** It moves to `.claude/skills/deploy/SKILL.md` and versions in lockstep with `app/src/lib/auth.ts` and the env contract.
2. **Callback registration: API automation with a manual fallback.** A helper script registers each new VM's callback with Pocket ID and verifies the write by re-reading. Without an API key, the skill prints the manual step and pauses.

## 1. Relocation and retirement

- Create `.claude/skills/deploy/SKILL.md` (invoked as `/deploy`), keeping the current frontmatter's allowed-tools.
- In the VibesOS repo (`~/.claude/plugins/marketplaces/VibesOS`, pushes to `popmechanic/VibesOS`): delete the julian plugin's `skills/deploy/`, bump the plugin to 0.1.2, and note the new location in its README. After the next plugin update, `/julian:deploy` no longer resolves to the stale copy.
- `deploy/instances.json` and the systemd units stay in `deploy/`.

## 2. Content fixes (the nine verified defects)

1. **OIDC pre-flight.** Check `.env` for `VITE_OIDC_ISSUER` (expect `https://souls.exe.xyz`) and `VITE_OIDC_CLIENT_ID`. Drop `VITE_OIDC_AUTHORITY` and the `studio.exe.xyz/auth` suggestion. Document that the Bun server also honors `OIDC_ISSUER` (falls back to the VITE_ value) and `OIDC_JWKS_JSON` (test seam), and that the token audience is the client ID.
2. **App build.** `app/dist` is gitignored and the server serves it at root. Provision runs, and Update reruns when the diff touches `app/` or `shared/`: `(cd shared && bun install) && (cd app && bun install && bunx vite build)`.
3. **Callback registration.** New provision step: run the helper script (section 3) after VM creation and before verification. On the no-API-key exit code, print the manual step (souls.exe.xyz → OIDC Clients → Julian → add `https://<vmname>.exe.xyz/auth/callback`) and wait for Marcus.
4. **Branch-aware provisioning.** Provision checks out the branch being deployed and records it in `instances.json`. Update pulls the branch recorded there, not whatever the clone is on.
5. **Deploy-key verification.** After `gh repo deploy-key add`, confirm with `gh repo deploy-key list | grep <title>`; retry once on absence. Never trust the silent success.
6. **VM name validation.** Before `ssh exe.dev new`: 5–52 characters, lowercase alphanumeric with single hyphens. Fail with a clear message ("soul" failed at 4 characters).
7. **Env template.** The VM's `.env` gets exactly `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, and `ALLOWED_ORIGIN=https://<vmname>.exe.xyz`. `POCKETID_API_KEY` lives only in the **local** `.env` — the helper script runs on the deploying machine, and the key must never reach a VM.
8. **Correctness nits.** `ssh exe.dev ls` (not `list`); remote-side quotes for lobby-REPL arguments containing spaces; `share set-public` called out as a deliberate publish step.
9. **Post-provision reporting.** State that `/api/health` returns `needsSetup: true` until the one-time Anthropic OAuth handshake (CONNECT TO CLAUDE screen, Marcus's account). During implementation, verify `julian-screen.service` matches the rebuilt repo layout (port 3848 internal) and check whether `julian-bridge.service` is dead; if dead, delete it from `deploy/`.

## 3. Helper script — `deploy/pocketid-register-callback.ts`

*(Planning amendment: Bun TypeScript rather than `.sh` — bash+jq JSON surgery is the fragility the verify-by-re-read rule exists to avoid, and Bun is already on every machine involved. Contract unchanged.)*

- **Input:** VM name. **Env:** `POCKETID_API_KEY`, issuer from `VITE_OIDC_ISSUER`, client ID from `VITE_OIDC_CLIENT_ID` (all via `.env`).
- **Behavior:** GET the client config from the Pocket ID admin API; if the callback is absent, add it and PUT; GET again; exit 0 only when the re-read shows the callback. Idempotent — a re-run on a registered callback exits 0 without writing.
- **No key:** exit with a distinct code and print the manual instructions; the skill treats that code as "pause for Marcus."
- **Rationale:** Pocket ID admin sessions expire quickly and saves fail silently; the handoff requires verification by re-reading, not by writing. The script exists so this discipline is code, not prose an agent can shortcut.
- Verify the actual admin API endpoints against Pocket ID's documentation during implementation; the client page's API-access tab is the starting point.
- **One-time dependency:** Marcus creates an API key in the Pocket ID admin UI and adds `POCKETID_API_KEY` to `.env`.

## 4. Verification

Provision `julian-skilltest` (valid name, 16 characters) by following the vendored skill exactly. **Zero tolerated deviations: any deviation is a remaining bug in the skill.** Gates:

- `systemctl is-active julian julian-screen` reports active.
- `/api/health` responds (with `needsSetup: true` — expected, not a failure).
- The helper script's re-read confirms the callback is registered.
- Marcus's passkey smoke is optional on top.

Teardown afterward: `ssh exe.dev rm julian-skilltest`, delete the deploy key from GitHub, remove the `instances.json` entry.

## Constraints

- No merges to `ultra/integration-20260726-012506` or `main`; the end gate stays with Marcus.
- Nothing in `app/` or `server/` changes. This work touches `.claude/skills/deploy/`, `deploy/`, docs, and the VibesOS repo only.

## Out of scope

- Automating Pocket ID API-key creation (needs an admin session by design).
- Wildcard callback registration (rejected: mild phishing surface via claimable `julian-*.exe.xyz` names).
- Any rework of the deploy process itself beyond making the skill describe it truthfully.
