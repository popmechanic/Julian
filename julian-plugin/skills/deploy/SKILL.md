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

### Step 5: Install nginx config

```bash
scp deploy/nginx-julian.conf <vmname>.exe.xyz:/tmp/nginx-julian.conf
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo cp /tmp/nginx-julian.conf /etc/nginx/sites-available/julian && \
  sudo ln -sf /etc/nginx/sites-available/julian /etc/nginx/sites-enabled/julian && \
  sudo rm -f /etc/nginx/sites-enabled/default && \
  sudo nginx -t && sudo systemctl restart nginx"
```

If `nginx -t` fails, stop and show the error. Do not restart nginx with a broken config.

**Why `restart` not `reload`**: On a fresh VM, nginx may be stopped (not running). `systemctl reload` fails on a stopped service; `restart` is idempotent — it starts the service if stopped, or restarts it if running.

**Port note**: The nginx config listens on both port 80 and port 8000. exe.dev's edge proxy routes incoming HTTPS traffic to port 8000 on the VM (must be in the 3000-9999 range). Port 80 is for local testing.

**proxy_pass note**: The `proxy_pass http://127.0.0.1:3847;` directive must NOT have a trailing slash. A trailing slash (e.g., `http://127.0.0.1:3847/`) would strip the `/api/` prefix from the forwarded request, breaking route matching in server.ts.

### Step 6: Copy static files to nginx root

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo cp /opt/julian/index.html /var/www/html/ && \
  sudo cp /opt/julian/sw.js /var/www/html/ && \
  sudo cp -r /opt/julian/bundles /var/www/html/ && \
  sudo cp -r /opt/julian/assets /var/www/html/ && \
  sudo cp -r /opt/julian/memory /var/www/html/"
```

### Step 7: Create .env file

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "cat > /opt/julian/.env << 'ENVEOF'
VITE_CLERK_PUBLISHABLE_KEY=pk_test_aW50ZXJuYWwtZGluZ28tMjguY2xlcmsuYWNjb3VudHMuZGV2JA
ALLOWED_ORIGIN=https://<vmname>.exe.xyz
ENVEOF"
```

### Step 8: Install and start systemd services

```bash
scp deploy/julian-bridge.service <vmname>.exe.xyz:/tmp/
scp deploy/julian-screen.service <vmname>.exe.xyz:/tmp/
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo cp /tmp/julian-bridge.service /etc/systemd/system/ && \
  sudo cp /tmp/julian-screen.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now julian-bridge julian-screen"
```

### Step 9: Verify deployment

Run these checks and report results:

```bash
# Check services are running
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "systemctl is-active julian-bridge julian-screen"

# Check static site loads
curl -sf https://<vmname>.exe.xyz/ | head -5

# Check bridge API responds
curl -sf https://<vmname>.exe.xyz/api/health
```

If the bridge returns `needsSetup: true`, that's expected for new instances — Anthropic credentials need one-time setup.

## Post-Deploy Summary

After deployment, report:

- **URL**: `https://<vmname>.exe.xyz/`
- **Services**: bridge (port 3847) and screen (port 3848) status
- **Auth**: Clerk works automatically. If this is a new instance, remind the user that Anthropic credentials require one-time setup — either visit the URL (setup screen) or run `ssh <vmname>.exe.xyz "claude setup-token"`.

## Updating an Existing Deployment

When the VM already exists, skip VM creation and Bun installation (Step 1 creation/install parts). The rsync in Step 3 is idempotent. After rsync:

- Copy CLAUDE.md: `scp deploy/CLAUDE.server.md <vmname>.exe.xyz:/opt/julian/CLAUDE.md` (every deploy, since the artifact catalog may have changed)
- Run `bun install` (Step 4) in case dependencies changed
- Restart services: `ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "sudo systemctl restart julian-bridge julian-screen"`
- Re-copy static files (Step 6) in case they changed
- Verify (Step 9)

No need to recreate nginx config or .env unless this is the first deploy to that VM. Check if `/etc/nginx/sites-enabled/julian` exists to determine if this is a first-time deploy:

```bash
ssh -o StrictHostKeyChecking=accept-new <vmname>.exe.xyz "test -f /etc/nginx/sites-enabled/julian && echo exists || echo missing"
```

If it exists, skip Steps 5, 7, and 8's systemd install — just rsync, install deps, copy static files, restart services, and verify.

## Error Recovery

- **DNS not resolving after 90 seconds**: The VM may not have been created successfully. Run `ssh exe.dev list` to verify it exists. If it does, wait longer or ask the user to check exe.dev status.
- **nginx restart fails (nginx not installed)**: Fresh exe.dev VMs should have nginx, but if missing: `ssh <vmname>.exe.xyz "sudo apt-get update && sudo apt-get install -y nginx"`, then retry Step 5.
- **nginx config test fails**: Show the error output. The old config is still active, so the site still works.
- **Service won't start / no journal entries**: Usually means Bun is missing. Verify with `ssh <vmname>.exe.xyz "/home/exedev/.bun/bin/bun --version"`. If missing, run the Bun install from Step 1.
- **502 from `/api/health`**: The bridge service isn't running. Check logs: `ssh <vmname>.exe.xyz "journalctl -u julian-bridge -n 20 --no-pager"`. Common causes: missing Bun binary, missing `jose` dependency (run `bun install`), or wrong port in nginx config.
- **curl verification fails**: Check if services are running, check nginx error log: `ssh <vmname>.exe.xyz "sudo tail -20 /var/log/nginx/error.log"`
- **VM creation fails**: Check exe.dev status, retry once.
