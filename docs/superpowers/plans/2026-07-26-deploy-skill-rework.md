# Deploy-Skill Rework Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the deploy skill into this repo and fix all nine defects verified during the julian-new deploy, with Pocket ID callback registration automated and verified by re-read.

**Architecture:** The skill becomes prose at `.claude/skills/deploy/SKILL.md`; the one discipline-critical piece — registering a VM's OAuth callback with Pocket ID and never trusting a silent save — becomes a small Bun script with a mock-server test. A live throwaway provision (`julian-skilltest`) is the end-to-end acceptance; the VibesOS plugin copy retires afterward.

**Tech Stack:** Bun + TypeScript (script and tests, `bun test`), markdown skill file, Pocket ID admin API, exe.dev VMs, systemd.

**Acceptance:** suite — the committed mock-server test gates the script; the live julian-skilltest provision (manual task) is the end-to-end acceptance. No seal requested.

## Global Constraints

- Work on branch `ultra/docket-20260726-122411`. Never merge to `ultra/integration-20260726-012506` or `main` — that end gate is Marcus's.
- Do not modify anything under `app/` or `server/`.
- `POCKETID_API_KEY` lives only in the **local** `.env`. It must never be written to any VM's `.env` or appear in any committed file.
- OIDC contract (fixed): issuer `https://souls.exe.xyz`; env keys `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID`; the Bun server additionally honors `OIDC_ISSUER` (fallback to the VITE_ value) and `OIDC_JWKS_JSON` (test seam); token audience = `VITE_OIDC_CLIENT_ID`.
- The root test suite has 6 pre-existing failures. Gate only on `bun test tests/server/pocketid-callback.test.ts`; never "fix" unrelated failing tests.
- Helper CLI contract (pinned for all tasks): `bun deploy/pocketid-register-callback.ts <vmname>` reads `POCKETID_API_KEY`, `POCKETID_ISSUER` (default `VITE_OIDC_ISSUER`), `POCKETID_CLIENT_ID` (default `VITE_OIDC_CLIENT_ID`) from the environment. Exit 0 = callback present on re-read; exit 3 = no API key (manual instructions printed to stderr); exit 1 = any failure, including a write that does not survive re-read.

---

### Task 1: Pocket ID callback-registration script with mock-server test

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Create: `deploy/pocketid-register-callback.ts`
- Test: `tests/server/pocketid-callback.test.ts`

**Interfaces:**
- Consumes: none
- Produces: CLI `bun deploy/pocketid-register-callback.ts <vmname>` with the exit-code contract from Global Constraints (0 verified / 3 no-key / 1 failure)

**Parallelization rationale:** contract-first — the CLI contract is pinned in Global Constraints, so the skill prose (a sibling task) and this script can be authored independently.

Pocket ID admin API contract assumed here (pinned by the mock; confirmed against the live instance in the manual verification task): `GET {issuer}/api/oidc/clients/{clientId}` returns the client JSON including `callbackURLs: string[]`; `PUT` to the same path with the full modified object saves it; auth header `X-API-KEY: <key>`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/pocketid-callback.test.ts
import { test, expect } from "bun:test";
import { resolve } from "path";

const SCRIPT = resolve(import.meta.dir, "../../deploy/pocketid-register-callback.ts");

type MockOpts = { existing?: string[]; persistWrites?: boolean };

function mockPocketId(opts: MockOpts = {}) {
  const state = {
    callbackURLs: opts.existing ?? ["https://julian-new.exe.xyz/auth/callback"],
    puts: [] as any[],
    gets: 0,
    apiKeysSeen: [] as (string | null)[],
  };
  const server = Bun.serve({
    port: 0, // unique free port per test — concurrency-safe
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/oidc/clients/julian-client")) {
        return new Response("not found", { status: 404 });
      }
      state.apiKeysSeen.push(req.headers.get("x-api-key"));
      if (req.method === "GET") {
        state.gets++;
        return Response.json({ id: "julian-client", name: "Julian", callbackURLs: state.callbackURLs });
      }
      if (req.method === "PUT") {
        const body = await req.json();
        state.puts.push(body);
        if (opts.persistWrites !== false) state.callbackURLs = body.callbackURLs;
        return Response.json({ id: "julian-client", name: "Julian", callbackURLs: state.callbackURLs });
      }
      return new Response("bad method", { status: 405 });
    },
  });
  return { server, state, issuer: `http://localhost:${server.port}` };
}

async function runScript(issuer: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", SCRIPT, "julian-skilltest"], {
    env: {
      ...process.env,
      POCKETID_ISSUER: issuer,
      POCKETID_CLIENT_ID: "julian-client",
      POCKETID_API_KEY: "test-key",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

test("registers a missing callback and verifies by re-read", async () => {
  const { server, state, issuer } = mockPocketId();
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(0);
  expect(state.puts.length).toBe(1);
  // preserves existing callbacks and appends the new one
  expect(state.puts[0].callbackURLs).toEqual([
    "https://julian-new.exe.xyz/auth/callback",
    "https://julian-skilltest.exe.xyz/auth/callback",
  ]);
  // GET before the write plus GET after the write = verify-by-re-read
  expect(state.gets).toBe(2);
  expect(state.apiKeysSeen.every((k) => k === "test-key")).toBe(true);
});

test("idempotent: already-registered callback exits 0 without writing", async () => {
  const { server, state, issuer } = mockPocketId({
    existing: ["https://julian-skilltest.exe.xyz/auth/callback"],
  });
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(0);
  expect(state.puts.length).toBe(0);
});

test("no API key: exits 3 with manual instructions", async () => {
  const { server, issuer } = mockPocketId();
  const r = await runScript(issuer, { POCKETID_API_KEY: undefined });
  server.stop();
  expect(r.exitCode).toBe(3);
  expect(r.stderr).toContain("https://julian-skilltest.exe.xyz/auth/callback");
  expect(r.stderr).toContain("OIDC Clients");
});

test("silent-save failure: PUT returns 200 but does not persist -> exit 1", async () => {
  const { server, issuer } = mockPocketId({ persistWrites: false });
  const r = await runScript(issuer, {});
  server.stop();
  expect(r.exitCode).toBe(1);
  expect(r.stderr).toContain("did not stick");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/server/pocketid-callback.test.ts`
Expected: FAIL — the script file does not exist, so every spawn exits nonzero with the wrong code/output.

- [ ] **Step 3: Write the script**

```typescript
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
```

Note the idempotent path: when the callback is already present, the script exits 0 after the single initial GET, without writing — the test asserts exactly one GET-write-GET cycle (two GETs) on the registering path and zero PUTs on the idempotent path.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/server/pocketid-callback.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add deploy/pocketid-register-callback.ts tests/server/pocketid-callback.test.ts
git commit -m "Add Pocket ID callback registration script (verify-by-re-read)"
```

---

### Task 2: Vendored deploy skill with all nine defect fixes

**Type:** implementation
**Depends-on:** none

**Files:**
- Create: `.claude/skills/deploy/SKILL.md`

**Interfaces:**
- Consumes: none (the helper CLI contract this skill invokes is pinned verbatim in Global Constraints)
- Produces: the `/deploy` skill document

**Parallelization rationale:** contract-first — this task writes prose against the pinned CLI contract, independent of the sibling that implements it.

- [ ] **Step 1: Create the vendored skill**

Start from the installed copy at `~/.claude/plugins/cache/VibesOS/julian/0.1.1/skills/deploy/SKILL.md` (read it; copy any section not named below unchanged), and write `.claude/skills/deploy/SKILL.md` with these exact changes:

**(a) Frontmatter** — replace entirely with:

```yaml
---
name: deploy
description: Deploy Julian to an exe.xyz VM (new instance or update existing)
user-invocable: true
allowed-tools:
  - Bash(ssh:*)
  - Bash(scp:*)
  - Bash(curl:*)
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(mkdir:*)
  - Bash(bun:*)
  - Bash(source:*)
  - Read
  - Write
  - Glob
---
```

**(b) Target VM section** — after the name-derivation list, add:

```markdown
**NAME VALIDATION**: exe.dev requires 5–52 characters, lowercase alphanumeric
with single hyphens (no leading/trailing hyphen, no doubles). Validate BEFORE
any exe.dev command and stop with a clear error if invalid — "soul" fails at
4 characters.
```

**(c) OIDC Pre-flight** — replace the whole subsection with:

```markdown
#### OIDC Pre-flight

Read the local `.env` and check for `VITE_OIDC_ISSUER` and `VITE_OIDC_CLIENT_ID`:

- **If both present** (issuer is an HTTPS URL; currently `https://souls.exe.xyz`):
  extract both for later. Proceed.
- **If missing**: STOP and have the user add to `.env`:
  `VITE_OIDC_ISSUER=https://souls.exe.xyz` and
  `VITE_OIDC_CLIENT_ID=<client id from the Pocket ID admin>`.

The Bun server also honors `OIDC_ISSUER` (falls back to the VITE_ value) and
`OIDC_JWKS_JSON` (test seam); the token audience is `VITE_OIDC_CLIENT_ID`.
The VM needs only the two VITE_ variables.
```

**(d) Pre-flight branch awareness** — in the Provision pre-flight, after "Get current git branch", add: `This branch is the deploy branch — it is checked out on the VM in Step P4 and recorded in the registry in Step P8.`

**(e) Step P1** — comment the publish step and add a quoting note:

```bash
ssh exe.dev new --name=<vmname>
ssh exe.dev share set-public <vmname>   # deliberate step: makes the VM publicly reachable
```

```markdown
Note: exe.dev commands run through a lobby REPL — arguments containing spaces
need remote-side quotes: `ssh exe.dev "new --name=x --comment='two words'"`.
```

**(f) Step P4** — after the `gh repo deploy-key add` block, add:

```markdown
**Verify the key registered** — the add can fail silently with no output:

    gh repo deploy-key list --repo popmechanic/Julian | grep "<vmname>-deploy"

If missing, re-run the add once; if still missing, STOP and report.
```

And change the clone line to check out the deploy branch:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "git clone git@github.com:popmechanic/Julian.git /opt/julian && cd /opt/julian && git checkout <branch>"
```

**(g) Step P5** — replace with root, shared, and app installs plus the SPA build:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && /home/exedev/.bun/bin/bun install && cd /opt/julian/shared && /home/exedev/.bun/bin/bun install && cd /opt/julian/app && /home/exedev/.bun/bin/bun install && /home/exedev/.bun/bin/bunx vite build"
```

```markdown
`app/dist` is gitignored and the server serves it at root — skip this build
and the site is blank.
```

**(h) Step P6** — the env template becomes exactly:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat > /opt/julian/.env << 'ENVEOF'
VITE_OIDC_ISSUER=<value from local .env>
VITE_OIDC_CLIENT_ID=<value from local .env>
ALLOWED_ORIGIN=https://<vmname>.exe.xyz
ENVEOF"
```

```markdown
Never copy `POCKETID_API_KEY` (or any other local secret) to a VM.
```

**(i) New Step P6c: Register the OAuth callback** — insert after the Claude-settings step (P6b), before P7:

````markdown
### Step P6c: Register the OAuth callback with Pocket ID

A new VM's callback URL must be registered with the Pocket ID client or
sign-in fails with `redirect_uri ... is not registered`:

```bash
source .env && bun deploy/pocketid-register-callback.ts <vmname>
```

- **Exit 0**: callback registered and verified by re-read. Continue.
- **Exit 3**: no `POCKETID_API_KEY` in the local `.env`. The script prints the
  manual step (Pocket ID admin -> OIDC Clients -> Julian -> add the callback).
  Have the user do it, confirm they re-opened the client and saw the URL
  listed (saves fail silently when admin sessions expire), then continue.
- **Exit 1**: STOP and report the script's output.
````

**(j) Step P7** — services are `julian` and `julian-screen` only (no bridge unit exists). Keep the existing commands.

**(k) Step P9** — replace the closing report line with:

```markdown
Report: URL and service status. `/api/health` returns `needsSetup: true`
until the one-time Anthropic OAuth handshake — open `https://<vmname>.exe.xyz/`
and complete the CONNECT TO CLAUDE screen with Marcus's account. On a fresh
VM this is expected, not an error.
```

**(l) Update pre-flight** — read the VM's `branch` from `deploy/instances.json` and use it throughout the Update path. Add to the change-analysis section: diffs touching `app/` or `shared/` trigger the SPA rebuild in Step U2.

**(m) Step U1** — replace the pull with a branch-aware version:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git fetch origin && git checkout <branch from instances.json> && git pull"
```

Keep the existing stash-recovery fallback.

**(n) Step U2** — keep the `package.json` check for root `bun install`, and add:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git diff --name-only ORIG_HEAD HEAD 2>/dev/null | grep -qE '^(app|shared)/' && echo rebuild || echo skip"
```

```markdown
On `rebuild` (or in doubt), run the Step P5 install + `vite build` command.
```

**(o) Error Recovery** — change `ssh exe.dev list` to `ssh exe.dev ls`; add: `**Sign-in fails with redirect_uri not registered**: run the Step P6c registration script for this VM.`

- [ ] **Step 2: Verify the content**

Run each; all must hold:

```bash
S=.claude/skills/deploy/SKILL.md
! grep -q "VITE_OIDC_AUTHORITY" $S
! grep -q "studio.exe.xyz" $S
! grep -q "exe.dev list" $S
! grep -q "julian-bridge" $S
grep -q "souls.exe.xyz" $S
grep -q "vite build" $S
grep -q "pocketid-register-callback" $S
grep -q "5–52" $S
grep -q "deploy-key list" $S
grep -q "needsSetup" $S
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/deploy/SKILL.md
git commit -m "Vendor deploy skill with julian-new deploy fixes"
```

---

### Task 3: Remove the dead julian-bridge service unit

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `deploy/julian-bridge.service`

**Interfaces:**
- Consumes: none
- Produces: none

`deploy/julian-bridge.service` is a byte-level duplicate of the main service unit (same `ExecStart=/home/exedev/.bun/bin/bun run /opt/julian/server/server.ts`) under a different unit name — a leftover, installed nowhere by the skill. `deploy/julian-screen.service` was audited during planning and is correct (`/opt/julian/julianscreen/server/index.js` exists in the rebuilt layout; internal port 3848): leave it untouched.

- [ ] **Step 1: Confirm it is unreferenced, then delete**

```bash
grep -rn "julian-bridge" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs . ; test $? -eq 1
git rm deploy/julian-bridge.service
```

(Mentions under `docs/` are historical records and stay.)

- [ ] **Step 2: Commit**

```bash
git commit -m "Remove dead julian-bridge.service (duplicate of julian.service)"
```

---

### Task 4: Script test gate

**Type:** gate
**Depends-on:** 1

Run: `bun test tests/server/pocketid-callback.test.ts`
Expected: PASS, 4 tests, 0 failures. Do not run the whole root suite as a gate — it carries 6 pre-existing failures unrelated to this work.

---

### Task 5: Marcus creates the Pocket ID API key

**Type:** manual
**Depends-on:** none

Marcus, in the Pocket ID admin at `https://souls.exe.xyz`:

1. Create an API key (the API-access tab on the Julian client page, or the admin's API Keys section), named `julian-deploy`.
2. Add `POCKETID_API_KEY=<the key>` to the **local** `.env` on this Mac.
3. The key never leaves this machine — it is not committed and never copied to a VM.

Without this, the registration script exits 3 and deploys fall back to the documented manual step — functional, but unverified-by-machine.

---

### Task 6: Live acceptance — provision julian-skilltest, then tear it down

**Type:** manual
**Depends-on:** 1, 2, 3, 4, 5

Follow the vendored `/deploy` skill **exactly** to provision `julian-skilltest` (valid name, 16 chars). **Zero tolerated deviations: any step that requires deviating is a remaining bug — fix the skill (and re-commit) before continuing.**

Gates, all required:

1. `ssh -o StrictHostKeyChecking=accept-new julian-skilltest.exe.xyz "systemctl is-active julian julian-screen"` → both `active`.
2. `curl -sf https://julian-skilltest.exe.xyz/api/health` → responds; `needsSetup: true` is expected, not a failure.
3. The registration script exits 0 — its re-read confirms the callback against the **real** Pocket ID. If the real API rejects the pinned contract (endpoint shape or `X-API-KEY` header), fix the script AND the mock test to match reality, re-run the Task 4 gate, and re-run this step.
4. Optional: Marcus's passkey smoke — sign in at `https://julian-skilltest.exe.xyz/`.

Teardown, all required:

```bash
ssh exe.dev rm julian-skilltest
gh repo deploy-key list --repo popmechanic/Julian   # find the julian-skilltest-deploy key id
gh repo deploy-key delete <key-id> --repo popmechanic/Julian
```

Then remove the `julian-skilltest` entry from `deploy/instances.json` (added during provisioning), and in the Pocket ID admin remove the `https://julian-skilltest.exe.xyz/auth/callback` URL from the Julian client. Commit the registry change: `git add deploy/instances.json && git commit -m "Deregister julian-skilltest after skill verification" && git push`.

---

### Task 7: Retire the VibesOS plugin copy

**Type:** release
**Depends-on:** 6

In `~/.claude/plugins/marketplaces/VibesOS` (pushes to `popmechanic/VibesOS`):

1. Locate the julian plugin source in the repo (the installed copy is julian 0.1.1) and `git rm -r` its `skills/deploy/` directory.
2. Bump the julian plugin version to `0.1.2` everywhere it is declared (the plugin's `.claude-plugin/plugin.json`, and the marketplace catalog if it pins versions).
3. Add to the plugin's README: `The deploy skill now lives in the Julian repo at .claude/skills/deploy/ — it must version in lockstep with the app it deploys.`
4. Commit (`Retire deploy skill — vendored into popmechanic/Julian`) and push.
5. Update the installed plugin (e.g. `/plugin` marketplace update) and confirm `/julian:deploy` no longer resolves while `/deploy` does.
