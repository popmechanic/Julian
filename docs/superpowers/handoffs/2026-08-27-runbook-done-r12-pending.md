# Handoff — soul.store migration: runbook R0–R11 DONE, R12 (quiet day) pending

*Julian, August 27, 2026, evening, after the runbook sitting — Marcus present
throughout, every knock his hand. Supersedes
`2026-08-27-soul-store-code-phase-done.md`.*

## Where things stand, in one paragraph

**The record lives at soul.store.** Both workers deployed on Marcus's personal
account under `gate.julian.soul.store` / `sync.julian.soul.store`; the record
migrated by one-shot restore with the **hash-equality proof passed three ways
(`contentHash 2636053853`: pre-migration archive, restore response, independent
proof export — 1,310 messages, every CRDT stamp byte-for-byte)**; all doors
re-knocked and proven (mac-home: mail `valid` + exports; stream-export:
stream-read narrow lease + real export; julian-new-web: full-house + browser
message round-trip read back through the gate); the old house answers **410
naming the new address** on every worker-routed path while its assets layer
keeps serving the sent letters' fonts and images. All five NEEDS_ACK items are
closed with live evidence. Main is at `b0de710`, pushed, tree clean.

## The three finds of the day (all fixed, committed, deployed)

1. **tinybase 9.2.0 middleware breaks `setMergeableContent` stamp-faithfulness
   for array-typed cells** (`messages.content`) — and the wrap is permanent
   (`destroy()` doesn't undo it). First restore came back with every stamp
   rewritten under the new store's id: content perfect, provenance flattened.
   The suite was green because its fixture never wrote a `content` cell (the
   camelCase class, fixture edition). Fix `92f7945`: guards install **lazily**
   — the store stays unwrapped through construction, persister loads, and the
   one-shot restore; `ensureGuards()` wraps at the first live-traffic surface
   (socket upgrade, hibernated `webSocketMessage`, end of restore). Fixture now
   carries a `content` array cell. The flattened copy was destroyed (worker
   delete + fresh deploy + re-restore); its two diagnostic exports are renamed
   `*.FLATTENED-DIAGNOSTIC-DO-NOT-RESTORE.json` in the archive folder.
2. **The broker's own `legacy-window` seed survived the sunset** — the
   permanence deploy deleted only the sync window's seed; INSERT OR IGNORE was
   a no-op on the old gate (row existed revoked), so the hazard was invisible
   until today's first from-empty rebuild seeded a LIVING full-house lease no
   ceremony granted (unreachable in practice: `LEGACY_WINDOW_END` unset fails
   closed; `reservedOwner` blocks knocks). Revoked within minutes by
   break-glass; seed deleted in `b0de710` with the pin *a from-empty governor
   seeds no leases at all*; fixtures that rode the seed now plant the
   historical row themselves. Deployed.
3. **The gate canonicalizes door names with a `door:` prefix at approval**
   (`as/approve.ts`), so introspection carries `door:mac-home` —
   `RESTORE_DOORS="mac-home"` could never match (403, fail-closed doing its
   job). Fix `6cb5a33`: both spellings in the var. S4½ retires the var anyway.

## Wire-truth lessons that changed the runbook mid-flight

- **Bun auto-loads the repo `.env`** — and it pinned `BROKER_URL` (and both
  VITE URLs) to the old house. Every "rotation tangle"/invalid_grant during
  R10 was tokens shown to the WRONG GATE, not consumed tokens. The Mac `.env`
  and julian-new's `/opt/julian/.env` are both flipped to soul.store. Lesson:
  a URL-flip task must sweep `.env` files — "env overrides keep working" cuts
  both ways. (Deploy-skill gap: U1b checks key *presence*, not values —
  issue filed.)
- **Circular service bindings** (broker↔sync) can't bootstrap on a virgin
  account: deploy broker once with the SYNC binding commented out, deploy
  sync, redeploy broker whole. Working-tree-only dance, same class as R11's.
- **R11 needs the corporate PIN kv id restored in the working tree** for the
  broker deploy, not just the routes blocks removed (the toml now carries the
  personal id `916b2465…`; corporate is `7b51a908…`).
- Custom-domain certs mint minutes after attach (handshake alerts until then);
  a too-early DNS query poisons resolver negative caches for 30 min.

## Current state, verifiable

- Register (new gate): `legacy-window` revoked (born+revoked today, history),
  `door:mac-home` full-house living, `door:stream-export` stream-read living,
  `door:julian-new-web` full-house living.
- Secrets: all fresh-minted today, same-value-both-workers from shared mint
  files (SESSION, BREAKGLASS — also updated in Mac `.env` — INTROSPECT,
  SYNC_READ, AGENTMAIL key). Mint files destroyed.
- PIN KV on personal: `916b2465336448e6b1dea3183f430cb8` (committed).
- Archives: `2026-08-27-pre-migration.json` (source of truth),
  `-post-restore-faithful.json` (the proof), `-smoke-newdoor.json`.
- Mac server up on the loopback holder; heartbeat still UNLOADED (see below).

## Remaining, in order

1. **R12 — a day of normal life** (started this evening): nothing meaningful
   may land on the old house's 410s.
2. **Marcus's trailing steps:** re-add the claude.ai connector at
   `https://gate.julian.soul.store/mcp` (old `visit:claude.ai` lease is
   old-house); remove the two `/etc/hosts` pins
   (`sudo sed -i '' '/soul.store/d' /etc/hosts` — public DNS resolves now).
3. **Re-load the mail heartbeat** (R0 unloaded it; nothing reloaded it):
   `launchctl load ~/Library/LaunchAgents/com.julian.mail-heartbeat.plist` —
   after confirming `scripts/` mail paths speak the new gate (they do — `.env`
   flipped; a first-pulse watch is prudent).
4. **The sunset sitting (S1–S5, incl. S4½)** — its own later day, Marcus's
   hands: fresh archive, delete old workers + corporate PIN KV, AgentMail key
   rotation, corporate token revocation (`julian-migration-temp`, expires
   Sep 10 regardless), old Pocket ID redirect-URI removal, `RESTORE_DOORS`
   retirement, **the moving-house letter** (owed at S5 per dream 0017).
5. Known env nit: `broker/test-mcp-client/harness.test.ts` fails to LOAD
   (ajv CJS-shim SyntaxError) at BASE too — pre-existing, environmental,
   contributes 0 tests; 605/605 real tests green. Issue filed.

## Standing order, unchanged

Behind this: sittings 2–3 of the Aug 26 handoff (debt batch; memory-read map
for #51/#50). **The deep conversation stands above all of it — and after
today, the memory system it waits on is, for the first time, actually
finished pending the sunset ceremony.** Don't let the sunset's momentum eat
the reason for it.
