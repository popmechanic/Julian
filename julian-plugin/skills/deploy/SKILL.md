---
name: deploy
description: Deploy Julian to an exe.xyz VM (new instance or update existing)
user-invocable: true
allowed-tools:
  - Bash(ssh:*)
  - Bash(rsync:*)
  - Bash(scp:*)
  - Bash(curl:*)
  - Bash(git:*)
  - Bash(mkdir:*)
  - Read
  - Glob
---

# Deploy Julian

Deploy Julian to an exe.xyz VM. Creates a new VM or updates an existing one.

Bun serves everything directly on port 8000 — static files, API, and SSE streaming. No nginx.

## Target VM

Determine the target VM name:

1. If `$ARGUMENTS` is provided, use it as the VM name (e.g., `/julian:deploy screen-test`)
2. If no arguments, derive from current git branch: `julian-<branch>` (e.g., branch `screen` → `julian-screen`)
3. Strip any characters not valid in hostnames (keep alphanumeric and hyphens)

**PRODUCTION SAFETY**: If the resolved VM name is exactly `julian` (the production instance), STOP and warn the user before proceeding. Explain that this will update the live production instance at `julian.exe.xyz`. Only proceed after explicit confirmation.

## Pre-flight Checks

1. Get the current git branch name: `git rev-parse --abbrev-ref HEAD`
2. Check for uncommitted changes: `git status --porcelain`
   - If dirty, warn the user but don't block (they may want to test local changes)
3. Confirm the target: print the VM name and URL (`https://<vmname>.exe.xyz/`)

### Clerk Pre-flight

Read the local `.env` file and check for `VITE_CLERK_PUBLISHABLE_KEY`:

- **If present** (matches `pk_(test|live)_*`): Extract the value and store it for Step 5. Proceed silently.
- **If missing or invalid**: STOP deployment and guide the user:
  - Option A: Run `/vibes:connect` to set up Clerk + Connect end-to-end
  - Option B: Manually add `VITE_CLERK_PUBLISHABLE_KEY=pk_test_...` to `.env`
  - Remind them to create the `with-email` JWT template in Clerk Dashboard:
    1. Go to Clerk Dashboard → Configure → JWT Templates
    2. Create a new template named **`with-email`**
    3. Set custom claims JSON (the `|| ''` fallbacks are required — Fireproof Studio rejects null names):
       ```json
       {
         "params": {
           "email": "{{user.primary_email_address}}",
           "email_verified": "{{user.email_verified}}",
           "external_id": "{{user.external_id}}",
           "first": "{{user.first_name || ''}}",
           "last": "{{user.last_name || ''}}",
           "name": "{{user.full_name || ''}}",
           "image_url": "{{user.image_url}}",
           "public_meta": "{{user.public_metadata}}"
         },
         "role": "authenticated",
         "userId": "{{user.id}}"
       }
       ```
  - After the user fixes `.env`, re-run the deploy

## Deployment Steps

### Step 1: Ensure VM exists and has Bun

**IMPORTANT**: All SSH commands targeting the VM (not `exe.dev`) must include `-o StrictHostKeyChecking=accept-new` to auto-accept the host key on first connection.

```bash
# Test if VM is reachable
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 <vmname>.exe.xyz echo ok
```

If the VM doesn't exist (SSH fails), create it:

```bash
ssh exe.dev new --name=<vmname>
ssh exe.dev share set-public <vmname>
```

After creating, wait for the VM to boot and DNS to propagate. Use a retry loop — fresh VMs take up to 90 seconds:

```bash
for i in $(seq 1 9); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 <vmname>.exe.xyz echo ok && break
  echo "Attempt $i failed, retrying in 10s..."
  sleep 10
done
```

If all 9 attempts fail, stop and report the DNS/connectivity issue to the user.

**Install Bun** (fresh exe.dev VMs do not have Bun pre-installed, and both systemd services depend on it):

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "curl -fsSL https://bun.sh/install | bash"
```

Skip Bun installation if the VM already had Bun (i.e., it was reachable on the first SSH test).

### Step 2: Create directory structure

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo mkdir -p /opt/julian && sudo chown exedev:exedev /opt/julian"
```

### Step 3: Rsync source files

From the Julian project root directory:

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  index.html sw.js package.json server memory bundles assets julianscreen deploy \
  <vmname>.exe.xyz:/opt/julian/
```

**IMPORTANT**: Directory names must NOT have trailing slashes. With trailing slashes, rsync copies directory *contents* into the target, flattening the structure (e.g., `server/` copies the files inside `server` directly into `/opt/julian/` instead of into `/opt/julian/server/`).

`package.json` is included because `server.ts` imports `jose`, which is listed as a dependency.

Then copy the server-specific CLAUDE.md (rsync can't rename files, so use scp):

```bash
scp deploy/CLAUDE.server.md <vmname>.exe.xyz:/opt/julian/CLAUDE.md
```

This gives Julian his identity bootstrap file — the wake-up sequence reads this to discover artifacts and remember who he is.

### Step 4: Install dependencies

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cd /opt/julian && /home/exedev/.bun/bin/bun install"
```

This installs `jose` and any other dependencies from `package.json`. Use the full path to `bun` because the SSH session may not have `.bun/bin` on its PATH.

### Step 5: Create .env file

Use the `VITE_CLERK_PUBLISHABLE_KEY` value extracted during the Clerk Pre-flight check (do NOT hardcode it):

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat > /opt/julian/.env << 'ENVEOF'
VITE_CLERK_PUBLISHABLE_KEY=<value from local .env>
ALLOWED_ORIGIN=https://<vmname>.exe.xyz
ENVEOF"
```

Replace `<value from local .env>` with the actual key read during pre-flight (e.g., `pk_test_aW50ZXJu...`). Never hardcode this value in the skill itself.

### Step 6: Install and start systemd services

```bash
scp deploy/julian.service <vmname>.exe.xyz:/tmp/
scp deploy/julian-screen.service <vmname>.exe.xyz:/tmp/
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo cp /tmp/julian.service /etc/systemd/system/ && \
  sudo cp /tmp/julian-screen.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now julian julian-screen"
```

**Migration from old setup**: If the VM previously ran the nginx-based setup, disable the old services:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo systemctl stop julian-bridge nginx 2>/dev/null; \
  sudo systemctl disable julian-bridge nginx 2>/dev/null; true"
```

Run this before enabling the new `julian` service.

### Step 7: Verify deployment

Run these checks and report results:

```bash
# Check services are running
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "systemctl is-active julian julian-screen"

# Check static site loads
curl -sf https://<vmname>.exe.xyz/ | head -5

# Check API responds
curl -sf https://<vmname>.exe.xyz/api/health
```

If the API returns `needsSetup: true`, that's expected for new instances — Anthropic credentials need one-time setup.

## Post-Deploy Summary

After deployment, report:

- **URL**: `https://<vmname>.exe.xyz/`
- **Services**: julian (port 8000) and julian-screen (port 3848) status
- **Auth**: Clerk works automatically. If this is a new instance, remind the user that Anthropic credentials require one-time setup — either visit the URL (setup screen) or run `ssh <vmname>.exe.xyz "claude setup-token"`.

## Updating an Existing Deployment

When the VM already exists, skip VM creation and Bun installation (Step 1 creation/install parts). The rsync in Step 3 is idempotent. After rsync:

- Copy CLAUDE.md: `scp deploy/CLAUDE.server.md <vmname>.exe.xyz:/opt/julian/CLAUDE.md` (every deploy, since the artifact catalog may have changed)
- Run `bun install` (Step 4) in case dependencies changed
- Restart services: `ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo systemctl restart julian julian-screen"`
- Verify (Step 7)

No need to recreate .env unless this is the first deploy to that VM. Check if the `julian` service exists to determine if this is a first-time deploy:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "systemctl is-active julian 2>/dev/null && echo exists || echo missing"
```

If it exists, skip Steps 5 and 6's systemd install — just rsync, install deps, restart services, and verify.

## Error Recovery

- **DNS not resolving after 90 seconds**: The VM may not have been created successfully. Run `ssh exe.dev list` to verify it exists. If it does, wait longer or ask the user to check exe.dev status.
- **Service won't start / no journal entries**: Usually means Bun is missing. Verify with `ssh <vmname>.exe.xyz "/home/exedev/.bun/bin/bun --version"`. If missing, run the Bun install from Step 1.
- **curl returns connection refused on port 8000**: The `julian` service isn't running. Check logs: `ssh <vmname>.exe.xyz "journalctl -u julian -n 20 --no-pager"`. Common causes: missing Bun binary, missing `jose` dependency (run `bun install`).
- **Old nginx still running**: If the VM had the old setup, nginx may be intercepting requests on port 8000. Run the migration step in Step 6 to stop and disable nginx and the old julian-bridge service.
- **401 on `/tokens/with-email`**: The Clerk instance is missing the `with-email` JWT template. Create it in Clerk Dashboard → Configure → JWT Templates. Name it exactly `with-email`. Claims must include a `params` object with email/name fields (use `|| ''` fallbacks — Fireproof Studio rejects null names), `"role": "authenticated"`, and `"userId": "{{user.id}}"`. See the Clerk Pre-flight section above for the full claims JSON. This is a one-time setup per Clerk instance. After creating the template, reload the deployed site — no redeploy needed.
- **VM creation fails**: Check exe.dev status, retry once.
