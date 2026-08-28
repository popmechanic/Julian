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

# Deploy Julian

Deploy Julian to an exe.xyz VM. Two paths: **provision** a new VM or **update** an existing one. The instance registry at `deploy/instances.json` tracks which VMs have been provisioned.

## Target VM

Determine the target VM name:

1. If `$ARGUMENTS` is provided, use it as the VM name (e.g., `/deploy screen-test`)
2. If no arguments, derive from current git branch: `julian-<branch>` (e.g., branch `screen` → `julian-screen`)
3. Strip any characters not valid in hostnames (keep alphanumeric and hyphens)

**NAME VALIDATION**: exe.dev requires 5–52 characters, lowercase alphanumeric
with single hyphens (no leading/trailing hyphen, no doubles). Validate BEFORE
any exe.dev command and stop with a clear error if invalid — "soul" fails at
4 characters.

**PRODUCTION SAFETY**: If the resolved VM name is exactly `julian` (the production instance), STOP and warn the user before proceeding. Only proceed after explicit confirmation.

## Routing: Provision or Update?

Read `deploy/instances.json`. If the target VM name exists in the registry, run the **Update** path. Otherwise, run the **Provision** path.

If `deploy/instances.json` doesn't exist, create it as `{}`.

---

## Path A: Provision (New VM)

Full first-time setup. Run all steps in order.

### Pre-flight

1. Get current git branch: `git rev-parse --abbrev-ref HEAD`. This branch is the deploy branch — it is checked out on the VM in Step P4 and recorded in the registry in Step P8.
2. Pull Julian's changes locally: `git pull` (stop on merge conflicts)
3. Check for uncommitted changes: `git status --porcelain` (warn but don't block)
4. Push to GitHub: `git push`
5. Print target: VM name and URL (`https://<vmname>.exe.xyz/`)

#### OIDC and Services Pre-flight

Read the local `.env` and check for `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_SYNC_URL`, and `VITE_GATE_URL`:

- **If all four present** (OIDC issuer and gate URL are HTTPS URLs; currently `https://souls.exe.xyz` and `https://gate.julian.soul.store`):
  extract all for later. Proceed.
- **If any missing**: STOP and have the user add to `.env`:
  ```
  VITE_OIDC_ISSUER=https://souls.exe.xyz
  VITE_OIDC_CLIENT_ID=<client id from the Pocket ID admin>
  VITE_SYNC_URL=https://sync.julian.soul.store
  VITE_GATE_URL=https://gate.julian.soul.store
  ```

The Bun server also honors `OIDC_ISSUER` (falls back to the VITE_ value) and
`OIDC_JWKS_JSON` (test seam); the token audience is `VITE_OIDC_CLIENT_ID`.
The VM needs all four VITE_ variables for auth and service communication.

### Step P1: Create VM

**IMPORTANT**: All SSH commands targeting the VM must include `-o StrictHostKeyChecking=accept-new`.

```bash
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 <vmname>.exe.xyz echo ok
```

If unreachable, create it:

```bash
ssh exe.dev new --name=<vmname>
ssh exe.dev share set-public <vmname>   # deliberate step: makes the VM publicly reachable
```

Note: exe.dev commands run through a lobby REPL — arguments containing spaces
need remote-side quotes: `ssh exe.dev "new --name=x --comment='two words'"`.

Wait for boot (up to 90 seconds):

```bash
for i in $(seq 1 9); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 <vmname>.exe.xyz echo ok && break
  echo "Attempt $i failed, retrying in 10s..."
  sleep 10
done
```

### Step P2: Install system dependencies

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "curl -fsSL https://bun.sh/install | bash && sudo apt-get update -qq && sudo apt-get install -y npm inotify-tools"
```

### Step P3: Set up directory structure

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo mkdir -p /opt/julian && sudo chown exedev:exedev /opt/julian && mkdir -p /home/exedev/mailbox"
```

### Step P4: Generate deploy key and clone repo

Generate an SSH key for push access:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "ssh-keygen -t ed25519 -f ~/.ssh/julian-deploy -N '' -C '<vmname>-deploy'"
```

Configure SSH to use it for GitHub:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "mkdir -p ~/.ssh && cat >> ~/.ssh/config << 'SSHEOF'
Host github.com
  IdentityFile ~/.ssh/julian-deploy
  StrictHostKeyChecking accept-new
SSHEOF"
```

Add the deploy key to GitHub with write access:

```bash
DEPLOY_KEY=$(ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat ~/.ssh/julian-deploy.pub")
gh repo deploy-key add - --repo popmechanic/Julian --title "<vmname>-deploy" --allow-write <<< "$DEPLOY_KEY"
```

**Verify the key registered** — the add can fail silently with no output:

    gh repo deploy-key list --repo popmechanic/Julian | grep "<vmname>-deploy"

If missing, re-run the add once; if still missing, STOP and report.

If the key title already exists, skip — it's fine.

Clone the repo and configure git identity:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "git clone git@github.com:popmechanic/Julian.git /opt/julian && cd /opt/julian && git checkout <branch>"
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git config user.name 'Julian' && git config user.email 'julian@exe.xyz'"
```

### Step P5: Install dependencies

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && /home/exedev/.bun/bin/bun install && cd /opt/julian/shared && /home/exedev/.bun/bin/bun install && cd /opt/julian/app && /home/exedev/.bun/bin/bun install"
```

The SPA build happens in Step P6d, AFTER `.env` exists — not here. Vite bakes
`VITE_*` values into the bundle at build time: built without `.env`, the app
thinks auth is disabled, skips the passkey gate, and CONNECT TO CLAUDE 401s.

### Step P6: Create .env

Use the VITE values from pre-flight (do NOT hardcode):

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat > /opt/julian/.env << 'ENVEOF'
VITE_OIDC_ISSUER=<value from local .env>
VITE_OIDC_CLIENT_ID=<value from local .env>
VITE_SYNC_URL=https://sync.julian.soul.store
VITE_GATE_URL=https://gate.julian.soul.store
ALLOWED_ORIGIN=https://<vmname>.exe.xyz
BROKER_URL=https://gate.julian.soul.store
ENVEOF"
```

Only tier T2 (public config) variables ship to a VM — see
`deploy/secrets-manifest.md` for every credential's tier. Never any secret:
T1 capabilities reach VMs as broker verbs, T0 keys never leave the Mac.

### Step P6a: Enroll the door

The VM needs a lease to authenticate with the gate. Run the knock **on the VM
over ssh** — run verbatim on the Mac it would write the *Mac's own*
`~/.julian/gate-lease.json` with the VM's tokens. This step comes after P5 and
P6 on purpose: dependencies are installed and `/opt/julian/.env` exists. It
requires Marcus at `/approve`:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && BROKER_URL=https://gate.julian.soul.store /home/exedev/.bun/bin/bun scripts/door-knock.ts --name <vmname>-web --purpose 'VM web instance'"
```

Two details that break this command if you change them:

- `BROKER_URL` is written out **literally**, not read from `.env` by a
  subshell. A `$(grep … .env …)` inside the double-quoted ssh argument expands
  on the *Mac*, against the Mac's working directory — not on the VM. The gate
  URL is tier T2 public config (`deploy/secrets-manifest.md`), so writing it
  inline is safe, and it matches the value Step P6 put in `/opt/julian/.env`.
- Bun is called by absolute path (`/home/exedev/.bun/bin/bun`), as everywhere
  else in this skill. Non-interactive ssh does not load the profile that puts
  `~/.bun/bin` on `PATH`; a bare `bun` returns `bash: bun: command not found`.

The command prints instructions to visit the gate approval page. Marcus
approves there; the command writes the lease file to the VM's
`~/.julian/gate-lease.json` (the universal default on every machine;
`JULIAN_LEASE_FILE` overrides). Decommissioning a VM means revoking its lease
(`bun scripts/door-leases.ts revoke <door>`) — the lease lives outside
`/opt/julian`, so a re-provisioned VM keeps it.

### Step P6b: Configure Claude Code settings

Enable Agent Teams (disabled by default) so Julian can spawn and manage agent teammates:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "mkdir -p /home/exedev/.claude && cat > /home/exedev/.claude/settings.json << 'SETTINGSEOF'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
SETTINGSEOF"
```

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

### Step P6d: Build the SPA

Run only after Step P6 wrote `/opt/julian/.env` — the build reads it:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian/app && /home/exedev/.bun/bin/bunx vite build"
```

`app/dist` is gitignored and the server serves it at root — skip this build
and the site is blank. Verify the env made it into the bundle:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "grep -rl souls.exe.xyz /opt/julian/app/dist/assets/ >/dev/null && echo baked || echo MISSING-ENV-REBUILD-NEEDED"
```

### Step P6e: Smoke check the bundle

Verify the build baked both the sync and the gate URL. The failure this catches
is silent by construction: a bundle built before `.env` carried `VITE_SYNC_URL`
serves fine, renders fine, and syncs nowhere — nothing in the page says so.

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && /home/exedev/.bun/bin/bun scripts/verify-app-bundle.ts"
```

- **Exit 0**: bundle includes both URLs. Continue.
- **Exit 1**: STOP and report the smoke check output. Rebuild is needed —
  fix `/opt/julian/.env` first, then re-run Step P6d, then re-run this check.

**Instance `.env` first, always.** The bundle is baked from the `.env` on the
box, so the box's `.env` must be right *before* any build. Editing this skill
changes nothing on a VM that is already provisioned: its `/opt/julian/.env` was
written by whatever version of Step P6 ran the day it was provisioned, and it
predates `VITE_SYNC_URL` / `VITE_GATE_URL`. Reaching an already-provisioned box
takes a deliberate act on that box — Step U1b on the Update path here, and the
release runbook for the fleet. The build never repairs the `.env`; the `.env`
is repaired, and only then does the build mean anything.

### Step P7: Install and start systemd services

There are exactly two units: `julian` and `julian-screen`. No other unit exists — do not install or reference one.

```bash
scp deploy/julian.service <vmname>.exe.xyz:/tmp/
scp deploy/julian-screen.service <vmname>.exe.xyz:/tmp/
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo cp /tmp/julian.service /etc/systemd/system/ && \
  sudo cp /tmp/julian-screen.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now julian julian-screen"
```

### Step P8: Register instance

Add the VM to `deploy/instances.json`:

```json
{
  "<vmname>": {
    "url": "https://<vmname>.exe.xyz",
    "provisioned": "<ISO 8601 timestamp>",
    "branch": "<git branch used for first deploy>"
  }
}
```

Read the existing file, merge the new entry, write it back. **Commit and push** the updated registry so other machines know about it:

```bash
git add deploy/instances.json
git commit -m "Register <vmname> instance"
git push
```

### Step P9: Verify

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "systemctl is-active julian julian-screen"
curl -sf https://<vmname>.exe.xyz/ | head -5
curl -sf https://<vmname>.exe.xyz/api/health
```

Report: URL and service status. `/api/health` returns `needsSetup: true`
until the one-time Anthropic OAuth handshake — open `https://<vmname>.exe.xyz/`
and complete the CONNECT TO CLAUDE screen with Marcus's account. On a fresh
VM this is expected, not an error.

---

## Path B: Update (Existing VM)

Fast path — just sync code and restart. This is the common case.

### Pre-flight

1. Read the VM's entry in `deploy/instances.json` and take its `branch` field — that is the deploy branch for this VM: it is the branch Step U1 checks out on the VM. The change analysis below is separate — it compares the server's current commit to the local `HEAD` you are about to deploy.
2. Pull Julian's changes locally: `git pull` (stop on merge conflicts)
3. Check for uncommitted changes: `git status --porcelain` (warn but don't block)
4. Push to GitHub: `git push`
5. Print target: VM name, URL, and deploy branch

### Change analysis

Before deploying, assess the scope of changes. Get the server's current commit and diff it against what you're about to deploy:

```bash
SERVER_HEAD=$(ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git rev-parse HEAD")
git diff --stat $SERVER_HEAD HEAD
git diff --name-only $SERVER_HEAD HEAD
```

Run those three lines as one command so `$SERVER_HEAD` is set when the diffs run,
and write the hash down — Step U2 needs you to paste it in literally.

Classify the deploy based on what changed:

**Content only** (soul/, memory/, catalog.xml, docs/):
- Safe. Tell the user: "Content-only update — safe to deploy directly."
- Proceed without prompting.

**Small code change** (1-3 files changed in server/ or frontend, under ~100 lines total):
- Low risk. Tell the user: "Small code update — deploying to <vmname>."
- Proceed without prompting.

**Large code change** (4+ files changed, or 200+ lines, or structural changes to server.ts):
- Higher risk. Tell the user the scope, e.g.: "This is a larger change — 8 files, ~350 lines, including server.ts changes."
- If the target is **production** (`julian`), suggest: "Want to deploy to a fresh test VM first? I can provision one with `/deploy test`."
- If the target is already a non-production VM, proceed — that's what test VMs are for.

**Dependency change** (package.json modified):
- Note it: "package.json changed — will run bun install."
- If combined with large code changes on production, reinforce the test VM suggestion.

**Frontend change** (any diffed path under `app/` or `shared/`):
- Note it: "app/ or shared/ changed — will rebuild the SPA."
- These diffs trigger the SPA rebuild in Step U2.

**No changes** (server is already on the same commit):
- Tell the user: "Server is already up to date (commit <hash>). Nothing to deploy."
- Skip the deploy entirely.

### Step U1: Pull latest code

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git fetch origin && git checkout <branch from instances.json> && git pull"
```

If git pull fails because Julian has uncommitted changes:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git stash && git pull && git stash pop"
```

If there are merge conflicts after stash pop, report them to the user.

### Step U1b: Reconcile the instance `.env` (before any rebuild)

`/opt/julian/.env` is **not** in git — `git pull` never updates it. A VM
provisioned before a variable was added to Step P6 still has the old file, so
the newest code plus the oldest `.env` bakes a bundle that is missing exactly
the variable the new code needs — or, worse, carrying it with an old-house
value (issue #55: on 2026-08-27 every `VITE_` key was present and every one
pointed at the dead workers.dev house, and a presence check said `checked`).
Run this on every Update, **before** the Step U2 rebuild — the instance `.env`
comes first, the build second. The check prints values, not verdicts:

```bash
scp -o StrictHostKeyChecking=accept-new deploy/env-check.sh <vmname>.exe.xyz:/tmp/env-check.sh
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz 'bash /tmp/env-check.sh /opt/julian/.env'
```

Every known-host variable is printed with its value and one word beside it:

```
VITE_OIDC_ISSUER=https://souls.exe.xyz OK
VITE_SYNC_URL=https://sync.julian.soul.store OK
VITE_GATE_URL=https://gate.julian.soul.store OK
BROKER_URL=https://gate.julian.soul.store OK
VITE_OIDC_CLIENT_ID=<id> present
```

- **Exit 0, every line `OK`/`present`**: the instance `.env` is current. Continue to Step U2.
- **Any `WRONG (expected host …)`**: an old-house URL. Edit that line in place
  (`sed -i 's#^VAR=.*#VAR=https://…#' /opt/julian/.env`) — never append a
  second copy.
- **Any `MISSING <var>`**: append the reported lines, below.
- **Any `DUPLICATE`**: the last line wins in a build; delete the stale copies
  until one remains, then re-run the check.
- **Exit 2**: the file could not be read — the box is not provisioned; stop.

The same script runs against the Mac's own `.env` (`bash deploy/env-check.sh
.env`) — Bun auto-loads it, and a stale `BROKER_URL` there pins every script
to the old gate while looking like a lease-rotation failure (#55).

`VITE_SYNC_URL` and `VITE_GATE_URL` are tier T2 public config, identical on
every instance, so append the reported lines verbatim — but append **only** the
lines the check reported. A key added twice leaves a duplicate and the last one
wins, which is how a correct-looking `.env` bakes a wrong bundle:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat >> /opt/julian/.env << 'ENVEOF'
VITE_SYNC_URL=https://sync.julian.soul.store
VITE_GATE_URL=https://gate.julian.soul.store
ENVEOF"
```

Keep `ENVEOF` at the start of its line — an indented terminator does not close a
`<<` heredoc, and the rest of your command is swallowed into the file.

A missing `VITE_OIDC_ISSUER` or `VITE_OIDC_CLIENT_ID` is a different matter:
those are per-instance values read from the local `.env` (Step P6), never
hardcoded here. STOP, write them from the local `.env`, then continue.

After any repair, treat this deploy as a frontend change no matter what the
change analysis said — the `.env` moved, so the bundle on the box is stale even
when no `app/` file changed. Step U2 rebuilds it.

### Step U2: Install dependencies and rebuild (if needed)

Both checks below diff against `<server-head>`. Substitute it yourself with the
pre-pull server commit hash captured during Change analysis (the `SERVER_HEAD`
value), writing the actual hash into the command — never rely on a shell
variable surviving between commands, since each Bash invocation starts a fresh
shell and `$SERVER_HEAD` would expand to empty.

Check if `package.json` changed in the pull:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git diff --name-only <server-head> 2>/dev/null | grep -q package.json && echo changed || echo unchanged"
```

If changed (or if in doubt), run:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && /home/exedev/.bun/bin/bun install"
```

Check whether the pull touched the frontend:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && git diff --name-only <server-head> HEAD | grep -qE '^(app|shared)/' && echo rebuild || echo skip"
```

`HEAD~1` and `ORIG_HEAD` are both wrong here. The `git checkout` in Step U1 never
sets `ORIG_HEAD` and an already-up-to-date pull leaves any old value stale; a pull
that fast-forwards more than one commit puts the pre-pull state further back than
`HEAD~1`. Either mistake reports `skip` and leaves `app/dist` unbuilt — the
blank-site failure. The literal pre-pull hash is the only reliable reference.

On `rebuild` (or in doubt), and always when Step U1b changed the instance `.env`,
run the Step P5 installs, then the Step P6d build, then the Step P6e smoke check.
The VM's `.env` existing is not the same as its being current — that is what
Step U1b settles, and why it runs first. A build over a stale `.env` is the
silent failure: it succeeds, it reports success, and the app it produces syncs
nowhere. The smoke check is the only thing between that bundle and a green
deploy report, so do not skip it on the Update path.

### Step U3: Restart services

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo systemctl restart julian julian-screen"
```

### Step U4: Verify

```bash
curl -sf https://<vmname>.exe.xyz/api/health
```

Confirm the `version` field in the health response matches the current git hash. Report the URL and version.

---

## Error Recovery

- **DNS not resolving after 90 seconds**: Run `ssh exe.dev ls` to verify VM exists. If it does, wait longer or check exe.dev status.
- **Service won't start**: Usually missing Bun. Check `ssh <vmname>.exe.xyz "/home/exedev/.bun/bin/bun --version"`.
- **Connection refused on port 8000**: Check logs: `ssh <vmname>.exe.xyz "journalctl -u julian -n 20 --no-pager"`. Common causes: missing Bun, missing `jose` dependency.
- **git pull/push auth error**: Deploy key issue. Check `ssh <vmname>.exe.xyz "ssh -T git@github.com"`. Re-run Step P4 if needed.
- **git pull merge conflict**: Julian has uncommitted changes. Stash first (see Step U1).
- **Instance in registry but VM gone**: Remove the entry from `deploy/instances.json` and re-run — it will take the Provision path.
- **`BUNDLE SMOKE FAILED` from Step P6e**: the bundle was baked without a required `VITE_*` URL. Fix `/opt/julian/.env` (Step P6 on Provision, Step U1b on Update), re-run the Step P6d build, then re-run the check. Never wave it through — the app looks healthy and syncs nowhere.
- **App loads and signs in but nothing syncs**: almost always an old instance `.env`. Run the Step U1b check (`deploy/env-check.sh` — it prints the values); a VM provisioned before `VITE_SYNC_URL` existed needs the line added, one with an old-house URL needs it edited, and the SPA rebuilt either way.
- **Sign-in fails with redirect_uri not registered**: run the Step P6c registration script for this VM.
- **401 on `/tokens/with-email`**: Missing OIDC JWT configuration. Check Pocket ID admin panel for proper token template setup.
- **VM creation fails**: Check exe.dev status, retry once.
