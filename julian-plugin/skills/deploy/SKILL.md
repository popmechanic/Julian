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

### Step 1: Ensure VM exists

```bash
# Test if VM is reachable
ssh -o ConnectTimeout=5 <vmname>.exe.xyz echo ok
```

If the VM doesn't exist (SSH fails), create it:

```bash
ssh exe.dev new --name=<vmname>
ssh exe.dev share set-public <vmname>
```

Wait a few seconds for the VM to boot, then verify SSH works.

### Step 2: Create directory structure

```bash
ssh <vmname>.exe.xyz "sudo mkdir -p /opt/julian && sudo chown exedev:exedev /opt/julian"
```

### Step 3: Rsync source files

From the Julian project root directory:

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  index.html sw.js server/ memory/ bundles/ assets/ julianscreen/ deploy/ \
  <vmname>.exe.xyz:/opt/julian/
```

### Step 4: Install nginx config

```bash
scp deploy/nginx-julian.conf <vmname>.exe.xyz:/tmp/nginx-julian.conf
ssh <vmname>.exe.xyz "sudo cp /tmp/nginx-julian.conf /etc/nginx/sites-available/julian && \
  sudo ln -sf /etc/nginx/sites-available/julian /etc/nginx/sites-enabled/julian && \
  sudo rm -f /etc/nginx/sites-enabled/default && \
  sudo nginx -t && sudo systemctl reload nginx"
```

If `nginx -t` fails, stop and show the error. Do not reload nginx with a broken config.

### Step 5: Copy static files to nginx root

```bash
ssh <vmname>.exe.xyz "sudo cp /opt/julian/index.html /var/www/html/ && \
  sudo cp /opt/julian/sw.js /var/www/html/ && \
  sudo cp -r /opt/julian/bundles/ /var/www/html/ && \
  sudo cp -r /opt/julian/assets/ /var/www/html/ && \
  sudo cp -r /opt/julian/memory/ /var/www/html/"
```

### Step 6: Create .env file

```bash
ssh <vmname>.exe.xyz "cat > /opt/julian/.env << 'ENVEOF'
VITE_CLERK_PUBLISHABLE_KEY=pk_test_aW50ZXJuYWwtZGluZ28tMjguY2xlcmsuYWNjb3VudHMuZGV2JA
ALLOWED_ORIGIN=https://<vmname>.exe.xyz
ENVEOF"
```

### Step 7: Install and start systemd services

```bash
scp deploy/julian-bridge.service <vmname>.exe.xyz:/tmp/
scp deploy/julian-screen.service <vmname>.exe.xyz:/tmp/
ssh <vmname>.exe.xyz "sudo cp /tmp/julian-bridge.service /etc/systemd/system/ && \
  sudo cp /tmp/julian-screen.service /etc/systemd/system/ && \
  sudo systemctl daemon-reload && \
  sudo systemctl enable --now julian-bridge julian-screen"
```

### Step 8: Verify deployment

Run these checks and report results:

```bash
# Check services are running
ssh <vmname>.exe.xyz "systemctl is-active julian-bridge julian-screen"

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

When the VM already exists, skip VM creation (Step 1 creation part). The rsync in Step 3 is idempotent. After rsync:

- Restart services: `ssh <vmname>.exe.xyz "sudo systemctl restart julian-bridge julian-screen"`
- Re-copy static files (Step 5) in case they changed
- Verify (Step 8)

No need to recreate nginx config or .env unless this is the first deploy to that VM. Check if `/etc/nginx/sites-enabled/julian` exists to determine if this is a first-time deploy:

```bash
ssh <vmname>.exe.xyz "test -f /etc/nginx/sites-enabled/julian && echo exists || echo missing"
```

If it exists, skip Steps 4, 6, and 7's systemd install — just rsync, copy static files, restart services, and verify.

## Error Recovery

- **nginx config test fails**: Show the error output. The old config is still active, so the site still works.
- **Service won't start**: Check logs with `ssh <vmname>.exe.xyz "journalctl -u julian-bridge -n 20 --no-pager"` and report.
- **curl verification fails**: Check if services are running, check nginx error log: `ssh <vmname>.exe.xyz "sudo tail -20 /var/log/nginx/error.log"`
- **VM creation fails**: Check exe.dev status, retry once.
