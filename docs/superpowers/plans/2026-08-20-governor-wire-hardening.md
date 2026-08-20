# Governor & Wire Hardening Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four small trust-core corrections in one pass: spent tickets free their mint slot (#36), burned-ticket replays stop growing the ledger unboundedly (#37), the stream cap becomes the documented per-lease aggregate 500/day (#35, Marcus's pick Aug 20), and the gate wire types stop letting impossible shapes typecheck (#33).

**Architecture:** #36/#37 land in `GovernorDO` (`mintTicket` counts only unspent tickets; `consumeTicket` writes at most one `ticket-reused` row per token). #35 changes `reserveLease`'s lease-side counting to service-wide for `stream` (the three verbs share one budget), leaving the per-verb key for every other service. #33 is type-only in `shared/gate-contract.ts`: `IntrospectionWire` becomes a discriminated union on `active`, and the consume-ticket error becomes a closed union derived from what `consumeTicket` actually returns — consumers in broker and sync must still compile with no behavior change.

**Tech Stack:** Cloudflare Workers + Durable Objects, vitest via @cloudflare/vitest-pool-workers.

**Spec:** Design approved in the Aug 20 sweep with Marcus (docket entry #36, `docs/superpowers/docket.md`; #35 disposition: aggregate). Issues #33/#35/#36/#37 + the Aug 20 triage comment on #36 (mechanism correction: `TICKET_MINT_CAP`, not the session cap) carry the defect statements.

**Acceptance:** suite — broker + sync vitest suites; no held-out exam requested.

## Global Constraints

- **The reuse alarm never dulls:** #37's collapse changes ledger *volume*, never detection — every re-presentation still returns `{ ok: false, error: 'reused' }`, and the FIRST reuse of a token always writes its row.
- **Type-only means type-only (#33):** no runtime value changes shape; every producer and consumer compiles against the tightened types with zero behavioral diffs (the suites prove it by staying green unmodified, except type annotations).
- **Cap semantics change only for `stream` (#35):** mail and every other service keep per-verb counting exactly as today.
- **TDD** for the two behavior changes (#36, #37, #35); #33 is compile-proven.

---

### Task 1: Ticket economics — free spent slots, collapse replay rows

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `broker/src/governor.ts`
- Test: `broker/test/governor-tickets.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: behavior contract — `mintTicket` refuses at `TICKET_MINT_CAP` **live unspent** tickets (a consumed ticket frees its slot immediately); `consumeTicket` writes the `ticket-reused` ledger row only for the first re-presentation of a given token (subsequent replays still return `reused` with no new row).

- [ ] **Step 1: Write the failing tests**

Append to `broker/test/governor-tickets.test.ts`, using its existing lease/mint/consume arrangement helpers (its cap and reuse tests are the authority for setup):

```ts
  test('a spent ticket frees its mint slot before the TTL (#36)', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const leaseId = await mintTestLease(g); // the file's existing arrangement helper
      // Fill the cap, consuming each ticket as it is minted: every slot is
      // spent, none expired.
      for (let i = 0; i < 10; i++) {
        const t = await mintTestTicket(g, leaseId);
        expect(t.status).toBe('ok');
        await consumeTestTicket(g, t);
      }
      // Cap is TICKET_MINT_CAP (10). With spent tickets freeing their slots,
      // the eleventh mint succeeds; today it answers 'cap' for the full 60s TTL.
      const eleventh = await mintTestTicket(g, leaseId);
      expect(eleventh.status).toBe('ok');
    });
  });

  test('a burned ticket ledgers its reuse once, not once per replay (#37)', async () => {
    await runInDurableObject(stub(), async (g: GovernorDO) => {
      const leaseId = await mintTestLease(g);
      const t = await mintTestTicket(g, leaseId);
      await consumeTestTicket(g, t); // legitimate spend
      const replay = () => consumeTestTicket(g, t);
      expect((await replay()).ok).toBe(false); // first re-presentation: the theft signal
      await replay();
      await replay(); // a retry loop hammers the same burned ticket
      const reuseRows = g.entries(200).filter((r) => r.verb === 'ticket-reused');
      expect(reuseRows.length).toBe(1); // one alarm, not a runaway ledger
      expect((await replay()).error).toBe('reused'); // detection undulled
    });
  });
```

(Replace `mintTestLease`/`mintTestTicket`/`consumeTestTicket` with the file's actual helper names — its existing cap and reused tests contain the exact calls; copy them.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && bun run test -- governor-tickets.test.ts`
Expected: FAIL — the eleventh mint answers `cap`; the reuse rows count 3.

- [ ] **Step 3: Implement**

In `broker/src/governor.ts`:

1. `mintTicket` (~line 882): the live count gains the unspent predicate:

```ts
      "SELECT COUNT(*) AS n FROM lease_tokens WHERE lease_id = ? AND kind = 'ticket' AND used = 0", leaseId
```

(with a comment: a spent ticket's row is retained so replays answer `reused` not `unknown` — retention justifies the row, not the slot (#36).)

2. `consumeTicket` burned-branch (~line 948): collapse per token:

```ts
    if (burn.rowsWritten === 0) {
      // One alarm per burned token (#37): the first re-presentation IS the
      // theft signal; a retry loop replaying the same burned ticket must not
      // grow the ledger without bound. Detection never dulls — every replay
      // still answers 'reused'.
      const already = Number(this.sql.exec(
        "SELECT COUNT(*) AS n FROM ledger WHERE sub = ? AND verb = 'ticket-reused' AND detail LIKE ?",
        sub, `%token_id=${tokenId}%`,
      ).one().n);
      if (already === 0) {
        this.ledger(
          now, sub, 'stream', 'ticket-reused',
          `door=${doorName} socket ticket presented twice token_id=${tokenId}`, false,
        );
      }
      return { ok: false, error: 'reused' };
    }
```

- [ ] **Step 4: Run to verify green**

Run: `cd broker && bun run test -- governor-tickets.test.ts` → PASS whole file (the pre-existing reuse test asserting the FIRST row still passes).

- [ ] **Step 5: Commit**

```bash
git add broker/src/governor.ts broker/test/governor-tickets.test.ts
git commit -m "governor: spent tickets free their slot; burned-ticket replays ledger once (#36, #37)"
```

---

### Task 2: The stream cap means what the doc says

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `broker/src/governor.ts`
- Modify: `broker/src/lease-auth.ts`
- Test: `broker/test/stream-verbs.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: behavior contract — a lease's `stream.*` reads draw one shared 500/day budget across `recent`/`session`/`search` (#35); `countSince` accepts `verb: string | null` (null = any verb of the service). Mail and all other services count per-verb, unchanged.

- [ ] **Step 1: Write the failing test**

Append to `broker/test/stream-verbs.test.ts` (its cap tests at ~line 260 show the arrangement):

```ts
  test('stream verbs share one per-lease budget — 500 total, not 3×500 (#35)', async () => {
    // Arrange a lease as the existing cap tests do, then spend mixed verbs:
    // consume N recent + M search reads and assert the refusal arrives at
    // recent+search+session = 500 combined, not per-verb. For test speed,
    // drive countSince directly if the file's cap tests do; otherwise insert
    // allowed ledger rows for two different stream verbs under one sub and
    // assert the next reserveLease refuses with count = the COMBINED total.
    // (Copy the mechanics from the existing per-verb cap test and change the
    // expectation from independent budgets to a shared one.)
  });
```

Write the test body concretely from the neighboring cap test's mechanics — the assertion that changes: rows written under `stream.recent` count against a subsequent `stream.search` reservation.

- [ ] **Step 2: Run to verify it fails**

Run: `cd broker && bun run test -- stream-verbs.test.ts`
Expected: FAIL — verbs count independently today.

- [ ] **Step 3: Implement**

1. `broker/src/governor.ts` `countSince` (~line 411): accept `verb: string | null`; when null, drop the verb predicate:

```ts
  private countSince(since: number, service: string, verb: string | null, sub: string | null): number {
    // verb null = the whole service shares one budget (#35: stream reads).
```

with the two query variants (existing per-verb, and a service-wide `WHERE sub = ? AND service = ? AND allowed = 1 AND ts >= ?` / global equivalent).

2. `reserveLease` (~line 462): the lease-side count keys service-wide for stream:

```ts
    const leaseCountVerb = service === 'stream' ? null : verb; // #35: one budget across stream verbs
    const leaseUsed = effectiveLeaseCap === null ? 0 : this.countSince(dayStart, service, leaseCountVerb, sub);
```

(The global count keeps its per-verb key — global stream caps are null in policy today, so no behavior rides on it; leave it untouched.)

3. `broker/src/lease-auth.ts:24-26`: the comment already says "a read a minute for twelve hours straight" — append `(one budget across the three stream verbs — #35)` so comment and counter finally agree. Update `broker/test/stream-verbs.test.ts:260-263`'s per-verb `leaseCapFor` assertions only if their meaning changed (the cap VALUE stays 500; what changed is the counting key).

- [ ] **Step 4: Run to verify green**

Run: `cd broker && bun run test -- stream-verbs.test.ts` then the whole broker suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add broker/src/governor.ts broker/src/lease-auth.ts broker/test/stream-verbs.test.ts
git commit -m "governor: stream reads share one per-lease 500/day budget, as documented (#35)"
```

---

### Task 3: Wire types close their sets

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `shared/gate-contract.ts`
- Modify: `broker/src/as/admin.ts`
- Modify: `sync/src/auth.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `IntrospectionWire` as a discriminated union — `{ active: true; lease_id: string; door_name?: string; scope: string; principal?: string; subject?: string; flow?: string; token_id?: string; exp?: number } | { active: false; reason?: 'token-expired' }` (field optionality per what producers actually send — `broker/src/as/admin.ts`'s introspection writers are the authority; the by-handle-only constraint on `reason` becomes structural). `ConsumeTicketError` as the closed union of every `error` string `GovernorDO.consumeTicket` returns (read them from the function: at minimum `'unknown' | 'reused' | 'expired'` plus its remaining arms), and `ConsumeTicketWire` split into `{ ok: true; lease_id: string; token_id?: string; subject?: string; scope: string; flow?: string; principal?: string; exp?: number } | { ok: false; error: ConsumeTicketError }`.

- [ ] **Step 1: Enumerate the real shapes**

Read every producer and consumer before editing: the introspection response writers in `broker/src/as/admin.ts` (`introspectLease`, `introspectJwt`, the by-handle re-auth arm), `GovernorDO.consumeTicket`'s return statements, and the consumers in `sync/src/auth.ts` + `sync/src/index.ts`. List each field's actual presence per branch — the union encodes what is sent, never an aspiration. (This is the whole point of #33: the type stops permitting `active:false` + `scope`, and stops permitting `active:true` without `lease_id`, only if those match reality.)

- [ ] **Step 2: Tighten the types**

Rewrite the two interfaces in `shared/gate-contract.ts` as the unions above (with the enumeration's corrections), keeping the existing field-level comments (move the `exp` comment onto the ok-arm, the `reason` by-handle comment onto the false-arm where it is now enforced by shape).

- [ ] **Step 3: Compile the tree; fix consumers by narrowing, never by casting**

Run: `cd broker && bunx tsc --noEmit` and `cd sync && bunx tsc --noEmit` (or the packages' check scripts if they exist).
Expected: narrowing errors where consumers read fields without discriminating. Fix each by an `if (wire.active)` / `if (wire.ok)` narrow — a fix that reaches for `as` is wrong by definition here.

- [ ] **Step 4: Run both suites unchanged**

Run: `cd broker && bun run test` and `cd sync && bun run test`
Expected: PASS with zero behavioral test edits — the constraint that proves type-only.

- [ ] **Step 5: Commit**

```bash
git add shared/gate-contract.ts broker/src/as/admin.ts sync/src/auth.ts
git commit -m "gate-contract: IntrospectionWire and consume-ticket results as discriminated unions (#33)"
```

---

### Task 4: Full verification

**Type:** gate
**Depends-on:** 1, 2, 3

Run, expected green: `cd broker && bun run test`, `cd sync && bun run test`, plus both `tsc --noEmit` checks.

---

### Task 5: Deploy rider

**Type:** release
**Depends-on:** 4

Rides the next gate/sync deploys already queued by the sibling plans, on Marcus's word. No secrets, no config.

---

## Self-review notes

- Spec coverage: #36 (Task 1, with the corrected mechanism from the triage comment), #37 (Task 1, collapse-per-token with detection preserved), #35 (Task 2, aggregate per Marcus's pick), #33 (Task 3, reality-derived unions).
- The #37 LIKE-query cost is bounded by the indexed (sub, …) prefix and reuse being an alarm path, not a hot path.
- Task 2's Step-1 test is deliberately mechanics-by-authority (the neighboring cap test) with its changed assertion stated exactly; the implementer copies arrangement, not intent.
- Wave shape: all three tasks independent (wave 1). Trust-core caps + ledger → the risk override routes to ultrapowers; Task 1 carries the adversarial review.
