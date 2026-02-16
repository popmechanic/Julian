# Git-Based Deploy and Bidirectional Content Sync

## Problem

Julian modifies files on the server (soul documents, memory artifacts, catalog.xml), but those changes are stranded. Getting them back requires manually SSHing in and copying files. Meanwhile, deploying code changes requires maintaining an rsync file list and a separate scp step for CLAUDE.md. Two problems, one solution.

## Design

### Git on the Server

The server becomes a git working copy instead of an rsync target. `/opt/julian/` is a `git clone` of the GitHub repo with a deploy key that has push access.

**Your changes flow forward:**
```
develop locally → git push → ssh vm "cd /opt/julian && git pull" → restart services
```

**Julian's changes flow back:**
```
Julian writes a file → git add → git commit → git push → you git pull locally
```

Both directions use git. No rsync, no manual file fetching.

### Ownership Boundary

| Owner | Files | Git access |
|---|---|---|
| Marcus | Application code: server.ts, index.html, chat.jsx, vibes.jsx, deploy/, docs/ | Full |
| Julian | Content + config: soul/, memory/, catalog.xml | Commit and push to main |

Julian does not modify application code. This is enforced by convention via CLAUDE.md instructions, not by file permissions.

### Merged CLAUDE.md

The current split — `CLAUDE.md` (dev instructions) and `deploy/CLAUDE.server.md` (Julian's identity bootstrap) — collapses into a single `CLAUDE.md`.

- Identity bootstrap (name, catalog.xml, Shelley) becomes a section in the merged file
- Dev instructions (frontend structure, deploy, summoning) remain as other sections
- Each reader takes what's relevant; the rest is harmless
- `deploy/CLAUDE.server.md` is deleted
- No more `scp` step in deploys

### Julian's Git Instructions (added to CLAUDE.md)

When Julian creates or modifies files in `soul/`, `memory/`, or `catalog.xml`:

1. Stage the changed files: `git add <specific files>`
2. Commit with a descriptive message
3. Push to main: `git push`

Guardrails:
- Only commit content files (soul/, memory/, catalog.xml)
- Never modify application code
- Never force push or rewrite history
- Commit immediately after changes so the working tree stays clean

### Revised Deploy Skill

**Existing deployment (the common case):**

```bash
# 1. Pull Julian's latest changes locally
git pull

# 2. Push your code changes
git push

# 3. Update the server
ssh <vm> "cd /opt/julian && git pull && bun install && sudo systemctl restart julian julian-screen"

# 4. Verify
curl -s https://<vm>.exe.xyz/api/health
```

**First-time VM setup:**

1. Create VM via exe.dev API
2. Install Bun
3. `git clone <repo-url> /opt/julian/`
4. Set up deploy key (SSH key with push access to the GitHub repo)
5. Create `.env` with `VITE_CLERK_PUBLISHABLE_KEY` and `ALLOWED_ORIGIN`
6. Install systemd services from `deploy/`
7. Verify

### Conflict Handling

Conflicts are unlikely because Marcus edits code files and Julian edits content files — different paths. If they occur:

- The deploy skill detects a failed `git pull` and reports the conflict
- Julian's CLAUDE.md instructions tell him to commit and push promptly, keeping the working tree clean
- If the server has uncommitted changes when you deploy, the skill stashes them first: `git stash && git pull && git stash pop`

### .env

`.env` stays gitignored. It lives only on each VM and is created during first-time setup. Contains `VITE_CLERK_PUBLISHABLE_KEY` and `ALLOWED_ORIGIN`.

## Implementation Steps

1. **Merge CLAUDE.md files** — combine `CLAUDE.md` and `deploy/CLAUDE.server.md` into one file, add Julian's git instructions
2. **Delete `deploy/CLAUDE.server.md`** — no longer needed
3. **Set up git on the server** — clone the repo to `/opt/julian/`, configure deploy key
4. **Rewrite the deploy skill** — replace rsync/scp with git pull
5. **Update `docs/architecture.md`** — reflect the new deploy model
6. **Test** — deploy via the new skill, have Julian make a content change, verify it flows back
