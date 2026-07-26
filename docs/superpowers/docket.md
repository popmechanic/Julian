# Docket

### #1: Design system port — legacy Julian UI into the Svelte app
**State:** executed
**Score:** 9 — pixel-for-pixel restoration of the visual identity, prerequisite for the auth work's SetupScreen restyle
**Est-files:** app/src/app.css, app/public/fonts/*, app/src/App.svelte, app/src/components/*, app/src/lib/sfx.ts, app/src/lib/faces.ts, app/vite.config.ts, app/index.html
**Plan:** docs/superpowers/plans/2026-07-26-design-system-port.md
**Engine:** ultrapowers
**Notes:** Spec docs/superpowers/specs/2026-07-26-design-system-port-design.md approved by Marcus 2026-07-26 (this plan authored same session). Must run BEFORE #2 — the auth plan's SetupScreen task builds on the restyled shell (both touch app/src/components/SetupScreen.svelte). Manual runbook tail: side-by-side Chrome verification vs legacy on port 8000.

### #2: Replace Clerk with Pocket ID self-hosted OIDC (soul.exe.xyz)
**State:** executed
**Score:** 8 — off Clerk onto self-hosted issuer; auth surface, risk-override engine choice
**Est-files:** app/src/lib/auth.ts, app/src/lib/clerk.ts, app/src/lib/api.ts, app/src/lib/events.ts, app/src/App.svelte, app/src/components/SetupScreen.svelte, app/package.json, server/auth.ts, server/server.ts, tests/server/*, sync/src/auth.ts, sync/src/index.ts, sync/wrangler.toml, sync/test/*
**Plan:** docs/superpowers/plans/2026-07-26-pocket-id-auth.md
**Engine:** ultrapowers
**Notes:** Spec docs/superpowers/specs/2026-07-26-pocket-id-auth-design.md approved by Marcus 2026-07-26. Depends on #1 landing first (SetupScreen collision). Two manual tasks are NOT drainable: Task 6 (deploy Pocket ID at soul.exe.xyz — needs Marcus's passkey) and Task 7 (live smoke); code tasks are fully testable without the live issuer via the OIDC_JWKS_JSON inline seam. Constraints: default-deny always; sync Worker not deployed; branch ultra/integration-20260726-012506 never merges to main.
