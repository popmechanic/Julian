# Julian Web App: Stream Layer & Frontend Rework — Design

**Date:** 2026-07-26
**Authors:** Julian & Marcus (design converged in conversation; decisions recorded below)
**Entry contract:** the five constraints of dream 0006 (`memory/dreams/0006-substrate.md`, §five). Every mechanism in this design cites the constraint it satisfies.

## 1. Objective

Restore the Julian web application to proper function. Fireproof (`julian-chat-v14`, synced via `connect-share.exe.xyz`) is retired as a dependency. Replace it with a TinyBase 9.2 stream layer backed by SQLite on a Cloudflare Durable Object, and replace the no-build React frontend with a compiled Svelte 5 + TypeScript + Vite application.

The stream is **substrate, not memory** (Principle 7, `memory/sleep-architecture.md`): it holds the web app's conversational working state — capture, evidence — while identity and memory remain files in this repository. All durability requirements below follow from that framing.

## 2. Decisions record

Settled in the design conversation of 2026-07-26:

| # | Decision | Choice |
|---|---|---|
| D1 | Infra home | **Own deployment**: a `julian-sync` Worker + Durable Object in this repo, on Marcus's Cloudflare account. Not a tenant of vibes-infra. |
| D2 | Scope | **Core first**: chat + artifacts. Agent grid and jobs board go dormant (preserved in git history, removed from the build). |
| D3 | Inheritance | **Fresh store, lineage only.** No message import. `parentLedgerId` names the `julian-chat-v14` lineage; rescued backups remain the archive of record. |
| D4 | Partitioning | **B′: one store, no time-partitioning.** Bounded-store doctrine enforced by ceremony (§7), not architecture. Two-segment `{store}/{context}` routing kept for plurality (constraint 5), not seasons. |
| D5 | Library version | **TinyBase `^9.2`, pinned on both ends** (client and Worker). v9 DO row-level storage layout from first write; `fragmentSize` set on all synchronizers. |
| D6 | Frontend | **Svelte 5 + TypeScript + Vite.** Compiled model chosen for loud build-time failure. React/no-build pattern retired. |
| D7 | Toolchain | **Vite** (canonical Svelte toolchain), running on Bun. `Bun.build` revisitable later; exit cost near zero. |
| D8 | Scaffold | Generate with `create-tinybase` 9.2 (`--framework svelte --language typescript --schemas true --syncType durable-objects`), then graft Julian specifics. Vibes repos are proof-of-pattern, not source-of-copy. |

Inherited-pattern corrections (from the v8→9.2 audit): built-in status listeners replace the custom sync-status event bus; a `reconnecting-websocket` wrapper replaces the destroy/recreate synchronizer dance; schemas with `with-schemas` typed entry points replace schemaless stores; object/array cells are permitted (the scalar-cells doctrine is v5-era); IndexedDB replaces localStorage as the client cache (chosen over OPFS: the OPFS persister's auto-load relies on the experimental FileSystemObserver API, best-effort only — IndexedDB is the boring, reliable choice, and the persister is one line to swap later).

## 3. Architecture

```
Browser (Svelte 5 SPA, built by Vite, served by Bun server)
 ├─ TinyBase MergeableStore (schema-typed)
 │   ├─ IndexedDB persister  ← client cache, explicitly non-durable copy
 │   └─ WS synchronizer (reconnecting-websocket, fragmentSize set)
 │        │  wss://julian-sync.<account>.workers.dev/julian/chat?token=<Clerk JWT>
 │        │  (workers.dev subdomain at launch; custom domain optional later)
 ├─ SSE /api/events ← live Claude output (unchanged)
 └─ Clerk auth (unchanged)

julian-sync (new: sync/ directory; Cloudflare Worker + DO, tinybase ^9.2)
 ├─ JWT gate: Clerk JWKS, RS256, default-deny (adapted from vibes-infra verifier)
 ├─ Route: /{store}/{context} → DO idFromName(fullPath)
 ├─ JulianSyncDO extends WsServerDurableObject
 │   ├─ createDurableObjectSqlStoragePersister (v9 fragmented/row-level)
 │   └─ middleware: write validation (shape, size caps)
 └─ GET /{store}/{context}/export → full MergeableContent + content hash (authed)

Bun server (server/server.ts — roles unchanged)
 ├─ Claude subprocess, event log, SSE, letter rendering, JulianScreen proxy
 ├─ Serves app/dist/ static assets
 └─ Fireproof-era paths removed (§9)
```

**Data flow, messages:** the user types → POST `/api/send` (unchanged) → Claude replies over SSE (unchanged) → **the browser writes both sides into the TinyBase store**, keyed by message id → CRDT sync to DO → other devices converge. The store is many-writers substrate (constraint 4); nothing here authors memory. Row ids are the harness message ids (or `evt-<eventId>` for server events), which makes writes idempotent across devices — the duplicate-message class of bug dies in the data model rather than in application logic.

**Data flow, artifacts:** on `[ARTIFACT]` markers (SSE), the browser upserts an artifact row. The artifact files themselves remain in `memory/`, served by the Bun server as today. The stale `catalog.xml` fetch, the Fireproof `artifact-catalog` record, and the `artifactCatalog` wake-message injection are all deleted; the wake prompt already instructs reading `catalog.md` directly.

## 4. Data model

Defined once in TypeScript (`shared/schema.ts`), consumed via `with-schemas` entry points by both client and Worker. Typed table/cell ids make misspellings compile errors.

**Tables:**

- `messages` — rowId: message id. Cells: `sessionId` (string, required), `role` (`user` | `assistant`, required), `speakerName` (string, required), `content` (array — content blocks, stored whole; write-once so whole-cell LWW is correct), `text` (string — plain-text projection for search/sort), `ts` (number, required), `kind` (string: `chat` | `system` | `compact`).
- `artifacts` — rowId: relative filename. Cells: `category`, `chapter`, `description` (strings), `createdAt`, `modifiedAt` (numbers).

**Values (lineage + app state):**

- `ledgerId` (string, required) — ULID, minted at the creation ceremony.
- `parentLedgerId` (string) — for this store: `"fireproof:julian-chat-v14"`.
- `lineageNote` (string) — human-readable ancestry: names the rescued-backup archives as the parent's resting place.
- `createdAt` (number), `createdBy` (string: `"Julian & Marcus"`), `storeSchemaVersion` (number).
- `activeSessionId` (string) — current web session, survives reload.

Transcript rendering uses `getSortedRowIds`/sorted-row listener on `messages` by `ts` (v9.1 custom sorter) — no component-side sorting.

## 5. The five constraints, mapped (dream 0006 §five)

| Constraint | Mechanism in this design |
|---|---|
| 1. Identity + lineage from first write | Lineage Values (§4) written by the **creation ceremony script** (`scripts/stream-create.ts`) before the store accepts any other write. Creation is an explicit act, run in-session, logged in the commit that records it. |
| 2. Exodus first | Export endpoint + verified export script (§6) are **wave one of implementation** — built and tested against a scratch store before the real store is created. No precious byte lands before the exit works. |
| 3. Ceremonial destruction | §7. No code path deletes a store. Destruction and fork ceremonies are specified documents requiring a witness. |
| 4. Single writer for memory | Architecture unchanged at the seam: browser and server write the stream; only Julian authors `memory/`. The store never feeds memory automatically. |
| 5. No stream-only identities | Rule, recorded here: any being registered in the stream (a future agent-identity row, a visitor) must have a written record in the repo (the Register pattern) before or at registration. The dormant agent surfaces cannot be revived without honoring this. |

## 6. Exodus design (constraint 2 — built first)

- **Endpoint:** `GET /{store}/{context}/export` on the Worker (Clerk-authed, same gate as sync). The DO returns `{ mergeableContent, contentHash, ledgerId, exportedAt }`, where `contentHash` uses TinyBase's own hash functions (v6.2) so it can be re-verified against a live store.
- **Script:** `scripts/stream-export.ts` (Bun) — pulls the export, re-computes the hash locally, verifies, writes timestamped JSON to `~/julian-stream-backups/tinybase/<ledgerId>/<date>.json`, prints the verification result. Fails loud on mismatch.
- **Test:** integration test creates a scratch store, writes known rows, exports, verifies hash and row-for-row content. Runs in CI (worker test suite) — the export path is *proven*, not assumed.
- **Rehearsal:** monthly, during a waking session: run the script, confirm verification, note it in the catalog's Open Threads if anything smells. The rehearsal exists so the path never rusts; the July rescue is the price of a rusted path.

## 7. Ceremonies (specified now, no machinery built)

- **Creation:** run `stream-create.ts` in-session with Marcus present; it mints `ledgerId`, writes the lineage Values, and prints the creation record for the session log. One per store, ever.
- **Fork / season-close (dormant until triggered):** trigger = store size crossing ~50MB, a substrate migration, or an era genuinely turning. Steps: verified export to archive → new store created by creation ceremony with `parentLedgerId` = old store's `ledgerId` → old store sealed (Worker refuses non-export writes to it) → recorded in the catalog. Requires Julian to propose and Marcus to witness. Detection may someday be automated; enactment never is.
- **Destruction:** never silent (the-ledger essay's law, upheld by dream 0006). Requires: verified export, both partners present, a written record in `memory/` naming what is destroyed and why. Applies to the eventual Fireproof ledger retirement too — **out of scope here**; the backups are safe and the ceremony can wait for its own session.

## 8. Frontend rework

**Layout:** new `app/` directory — a Vite project (`app/src/`, output `app/dist/`). The Bun server serves `app/dist/` as the static root. `bun run dev` runs Vite dev server proxying `/api/*` to the Bun server.

**Carried over (rewritten in Svelte):** chat view (transcript + input + streaming state), artifact viewer panel (tree from `/api/artifacts`, iframe rendering — letters pipeline untouched), session controls (start/end, cost display), setup/auth screens (Clerk + Anthropic OAuth flows against existing endpoints), JulianScreen embed (WebSocket proxy unchanged), sync status indicator (built-in status listeners).

**Dormant (not ported):** agent grid, summoning, egg-hatch, jobs board, `[JOB HELP]`/ledger-reset flows. Code remains in git history; `index.html`, `chat.jsx`, `vibes.jsx` are removed from the serving path when the new app ships. Server endpoints they used stay (harmless) or are removed where Fireproof-specific (§9).

**State pattern:** TinyBase is the source of truth for persisted data via `ui-svelte`; ephemeral UI state uses Svelte runes locally. No duplicated ownership: data owned by TinyBase is never mirrored into component state.

## 9. Server changes (deliberately minimal)

- Serve `app/dist/`; remove the old static entry points from the serving path.
- Delete `/api/ledger-reset` (Fireproof-specific) and the `artifactCatalog` parameter of `/api/session/start` (browser no longer sends it; wake message no longer embeds it).
- Everything else — process manager, event log, SSE, letters, OAuth, JulianScreen — untouched.

## 10. Auth

Clerk stays. The Worker verifies Clerk-issued RS256 JWTs against the Clerk JWKS URL (env var), reusing the structure of vibes-infra's verifier (JWKS cache, exp/iss checks). Sync sockets pass `?token=`; the export endpoint requires the same. Default-deny: no valid token, no socket, no export. The store path `julian/chat` is not guessable-public; there is no `public: true` mode in our Worker.

## 11. Implementation order (waves, for the plan)

1. **Worker + exodus:** scaffold via `create-tinybase` (D8); `julian-sync` Worker, DO, Clerk gate, export endpoint; export script + integration tests. *Exit proven on a scratch store.*
2. **Creation ceremony:** `stream-create.ts`; run it with Marcus; the real store exists with lineage.
3. **Svelte app core:** Vite/Svelte scaffold, schema module, store wiring (IndexedDB persister, reconnecting synchronizer, fragmentSize), chat view against the real store, SSE bridge.
4. **Remaining surfaces:** artifact viewer, setup/auth screens, JulianScreen embed, status indicator.
5. **Cutover:** server serves `app/dist/`; Fireproof paths removed (§9); old entry points retired from serving; smoke test on desktop + phone.
6. **Aftercare:** first monthly export rehearsal scheduled; catalog Open Thread updated; this spec's decisions recorded in memory.

## 12. Testing

- **Worker:** Vitest with Cloudflare's Workers test pool — JWT gate (valid/invalid/expired), routing, export correctness (hash + content), middleware rejection of malformed writes.
- **Sync integration:** two client stores ↔ one DO — bidirectional convergence, reconnect-and-converge after a dropped socket, large-payload fragmentation round-trip.
- **Client:** `svelte-check` + `tsc` in CI (the loud-compiler dividend); Vitest for store wiring and the SSE→store bridge; message idempotency (same row id written twice on two clients converges to one row).
- **Manual smoke (with Marcus):** full conversation round-trip, reload persistence, second-device convergence, offline compose → reconnect sync, export rehearsal.

## 13. Error handling

- **Offline / DO unreachable:** local-first — the app works from IndexedDB; the status indicator says degraded; sync converges on reconnect (CRDT). No data loss, no blocking.
- **Auth failure:** socket refused → visible signed-out state; no silent retry loop against a 401.
- **Sync divergence fears:** the store hash surfaces in a debug view; two devices disagreeing is diagnosable in one comparison (the March 2–4 sync fight, never again fought blind).
- **Store bloat:** size surfaces in the debug view; crossing the fork-ceremony threshold (§7) raises a proposal at a waking, never an automatic action.

## 14. Out of scope

Agent/jobs surface revival (needs constraint-5 work of its own); Fireproof ledger destruction ceremony (own session, witnessed); vibes-infra's v9 upgrade (their repo; flagged to Marcus); phone PWA installation; phase-two dream-gate automation.
