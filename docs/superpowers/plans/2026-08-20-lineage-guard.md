# Lineage Guard Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sync DO refuses to let the July 27 creation-ceremony lineage values be overwritten — server-side, unconditionally (issue #9) — and `storeSchemaVersion` retires (issue #8, Marcus's decision Aug 20: retire).

**Architecture:** Five lineage keys (`ledgerId`, `parentLedgerId`, `lineageNote`, `createdAt`, `createdBy`) become immutable-once-set inside `JulianSyncDO.installGuards`: the local path rejects via `addWillSetValueCallback`; the synchronizer-merge path (which bypasses per-value callbacks) strips lineage overwrites inside the existing `willApplyChanges` arm. Because the stamp tree has already merged the incoming value before the callback runs (the documented cell-guard reality), a blocked overwrite is converged away by a corrective two-step rewrite with the store's own newer HLC — bounce to a temp value, then restore the original, so both writes stamp and every replica converges back to the true lineage. `activeSessionId` stays mutable (runtime state, not lineage). Retirement removes `storeSchemaVersion` and the now-unused `SCHEMA_VERSION` export; the value was never durably stamped, so no live-store write occurs and the Marcus-present constraint is not triggered.

**Tech Stack:** Cloudflare Durable Object (sync), TinyBase MergeableStore + middleware, vitest via @cloudflare/vitest-pool-workers (`runInDurableObject` harness in `sync/test/do.test.ts`).

**Spec:** Design approved in the Aug 20 sweep with Marcus (docket entry #9, `docs/superpowers/docket.md`; #8 disposition: retire). Issue bodies #9/#8 carry the defect statements; the protected value is ledgerId `01KYJ9XT64DQDJ1P3V8KET1R7B` from the witnessed July 27 ceremony.

**Acceptance:** suite — the sync vitest suite covers both write paths and the convergence rewrite; no held-out exam requested.

## Global Constraints

- **First set always passes:** an empty store accepts the creation write — `scripts/lib/creation.ts` keeps working unchanged (its own in-memory guard remains as belt).
- **Equal re-writes pass:** setting a lineage key to its current value is a harmless stampless no-op, never a refusal.
- **The corrective rewrite must stamp:** a write equal to the plain-store current value stamps nothing (the oversized guard's documented lesson at `sync/src/do.ts:285-291`) — hence the two-step bounce; a single restore write would leave the foreign value winning in the stamp tree.
- **No live-store writes in this plan:** everything lands as code + tests; the deployed DO simply starts refusing.
- **TDD:** failing test first for each guard path.

---

### Task 1: The DO lineage guard

**Type:** implementation
**Depends-on:** none
**Review:** adversarial

**Files:**
- Modify: `sync/src/do.ts`
- Test: `sync/test/do.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: behavior contract — on a store whose lineage values exist, `setValue`/`setValues` of a differing lineage value leaves the prior value intact; an `applyChanges`-path lineage overwrite is stripped, receipted, and converged away by a corrective rewrite; first-ever sets and equal re-writes pass. Exported for tests: `LINEAGE_KEYS: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `sync/test/do.test.ts`, inside the existing `describe('JulianSyncDO', ...)`, using its `stub()`/`runInDurableObject` helpers:

```ts
  test('lineage: first set passes, overwrite is refused on the local path (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setValue('ledgerId', 'L1');
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // creation still works
      instance.store.setValue('ledgerId', 'EVIL');
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // once set, immutable
      instance.store.setValue('ledgerId', 'L1'); // equal re-write: harmless no-op
      expect(instance.store.getValue('ledgerId')).toBe('L1');
    });
  });

  test('lineage: every key in the set is guarded; activeSessionId stays mutable (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setValues({
        ledgerId: 'L1', parentLedgerId: 'P1', lineageNote: 'N1', createdAt: 111, createdBy: 'Julian & Marcus',
        activeSessionId: 's1',
      });
      instance.store.setValues({
        ledgerId: 'X', parentLedgerId: 'X', lineageNote: 'X', createdAt: 999, createdBy: 'X',
        activeSessionId: 's2',
      } as never);
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      expect(instance.store.getValue('parentLedgerId')).toBe('P1');
      expect(instance.store.getValue('lineageNote')).toBe('N1');
      expect(instance.store.getValue('createdAt')).toBe(111);
      expect(instance.store.getValue('createdBy')).toBe('Julian & Marcus');
      expect(instance.store.getValue('activeSessionId')).toBe('s2'); // runtime state, not lineage
    });
  });

  test('lineage: a merge-path overwrite is stripped and converged away (#9)', async () => {
    await runInDurableObject(stub(), async (instance: JulianSyncDO) => {
      instance.store.setValue('ledgerId', 'L1');
      // The synchronizer path: plain changes with stamps already stripped —
      // exactly what willApplyChanges receives from a foreign socket.
      instance.store.applyChanges([{}, { ledgerId: 'EVIL' }, 1] as never);
      expect(instance.store.getValue('ledgerId')).toBe('L1'); // plain store protected
      // Let the corrective microtask flush run, then confirm the stamp tree
      // converged back: a fresh merge of the store's own content must carry L1.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(instance.store.getValue('ledgerId')).toBe('L1');
      const content = instance.store.getMergeableContent() as unknown as [unknown, [Record<string, unknown>]];
      expect(JSON.stringify(content)).toContain('L1');
      expect(JSON.stringify(instance.store.getMergeableContent())).not.toContain('EVIL');
    });
  });
```

(If the mergeable-content assertion needs a different accessor shape in this TinyBase version, assert convergence the way the existing oversized-merge test in this file asserts its stamp-tree rewrite — that test is the authority for the flush-then-inspect pattern.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd sync && bun run test -- do.test.ts`
Expected: FAIL — today `EVIL` lands on every path (`willApplyChanges` returns `values` untouched; no value callback exists).

- [ ] **Step 3: Implement**

In `sync/src/do.ts`:

1. Near the guard constants, add:

```ts
// The creation ceremony's identity values (scripts/lib/creation.ts): once
// set, no socket may ever change them — the once-ever guard, server-side (#9).
// activeSessionId is runtime state and deliberately absent.
export const LINEAGE_KEYS = ['ledgerId', 'parentLedgerId', 'lineageNote', 'createdAt', 'createdBy'] as const;
```

2. Beside `#oversized`, add the receipt map and its restore queue:

```ts
  // Lineage overwrites blocked mid-merge: key → the true value to converge
  // back into the stamp tree (the incoming value already merged there before
  // the callback ran, same as the oversized cells).
  #lineageBlocked = new Map<string, unknown>();
```

3. In `installGuards`, register the local-path guard beside the cell callback:

```ts
    this.#middleware.addWillSetValueCallback((valueId, value) => {
      if (!(LINEAGE_KEYS as readonly string[]).includes(valueId)) return value;
      const existing = this.store.getValue(valueId);
      if (existing === undefined || existing === value) return value; // first set, or harmless equal re-write
      return undefined; // once set, lineage is immutable — reject, prior value stands
    });
```

4. In the `addWillApplyChangesCallback` body, guard `values` the way `tables` is guarded (and widen the existing `dropped` accounting):

```ts
      let guardedValues = values;
      if (values) {
        for (const key of LINEAGE_KEYS) {
          const incoming = (values as Record<string, unknown>)[key];
          if (incoming === undefined) continue;
          const existing = this.store.getValue(key);
          if (existing === undefined || existing === incoming) continue;
          if (guardedValues === values) guardedValues = { ...(values as Record<string, unknown>) } as typeof values;
          delete (guardedValues as Record<string, unknown>)[key];
          this.#lineageBlocked.set(key, existing);
          dropped = true;
        }
      }
```

and make the return use `guardedValues` in both arms:

```ts
      return (dropped ? [guarded, guardedValues, marker] : [tables, values, marker]) as Changes;
```

5. Extend the existing `addDidFinishTransactionListener` flush trigger to also fire on `#lineageBlocked.size`, and add the restore beside `flushOversized`:

```ts
  // Converge a blocked lineage overwrite away. The strip only protected the
  // plain store; the foreign value already merged into the stamp tree. A
  // single restore write would be a stampless no-op (it equals the plain
  // store's current value), so bounce: write a temp, then the true value —
  // two stamps, the second newest, every replica converges back (#9).
  flushLineageBlocked(): void {
    const pending = [...this.#lineageBlocked];
    this.#lineageBlocked.clear();
    for (const [key, trueValue] of pending) {
      this.store.transaction(() => {
        this.store.setValue(key as never, `${DROPPED_MARKER}:lineage-restore` as never);
      });
      this.store.transaction(() => {
        this.store.setValue(key as never, trueValue as never);
      });
    }
  }
```

(Wire it wherever `flushOversized` is invoked from the deferred microtask — the same `#flushing` discipline applies to both; the temp write's value is schema-valid for string keys, and for `createdAt` (a number) use `-1` as the temp: add `const temp = typeof trueValue === 'number' ? -1 : \`${DROPPED_MARKER}:lineage-restore\`;` and write `temp`. The willSetValue guard must not block these restore writes — they originate after `#lineageBlocked` cleared the plain value? No: the plain store still holds the true value, so the temp write differs and WOULD be rejected by the new local guard. Exempt the flush: set a private `#restoring = true` flag around the two transactions and have the willSetValue callback pass values through when `#restoring` is set.)

- [ ] **Step 4: Run to verify they pass**

Run: `cd sync && bun run test -- do.test.ts`
Expected: PASS whole file (the pre-existing schema/oversized tests must stay green — the values arm must not disturb the cell arm's behavior).

- [ ] **Step 5: Commit**

```bash
git add sync/src/do.ts sync/test/do.test.ts
git commit -m "sync: lineage values immutable once set, both write paths, converged restore (#9)"
```

---

### Task 2: Retire storeSchemaVersion

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `shared/schema.ts`
- Modify: `scripts/lib/creation.ts`
- Test: `scripts/lib/creation.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `VALUES_SCHEMA` without `storeSchemaVersion`; `SCHEMA_VERSION` export removed (its only consumers were the schema default and the creation write); `performCreation` writes the five lineage values + `activeSessionId` and nothing else.

- [ ] **Step 1: Write the failing test**

Append to `scripts/lib/creation.test.ts` (same store-construction helper its existing tests use):

```ts
  test('storeSchemaVersion is retired: creation writes no version marker (#8)', () => {
    const store = makeStore(); // the file's existing helper
    performCreation(store, { now: 1_700_000_000_000 });
    expect(store.getValue('storeSchemaVersion' as never)).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd scripts && bunx vitest run lib/creation.test.ts`
Expected: FAIL — the value is written today (as the schema default's equal, stampless echo).

- [ ] **Step 3: Implement**

1. `shared/schema.ts`: delete line 6 (`export const SCHEMA_VERSION = 2;`) and line 49 (`storeSchemaVersion: { type: 'number', default: SCHEMA_VERSION },`). Grep the tree (`git grep -n SCHEMA_VERSION -- ':!node_modules'`) — the only remaining consumer should be `creation.ts`; fix any straggler the grep finds.
2. `scripts/lib/creation.ts`: drop `SCHEMA_VERSION` from the import and the `storeSchemaVersion: SCHEMA_VERSION,` line from `setValues`.
3. Add a one-line comment where the field used to sit in `shared/schema.ts`:

```ts
  // storeSchemaVersion retired 2026-08-20 (#8): zero readers, never durably
  // stamped (default-equal writes are no-ops). Migration is by inspection;
  // a future version marker gets designed WITH its reader, not before.
```

- [ ] **Step 4: Run the affected suites**

Run: `cd scripts && bun run test` and `cd sync && bun run test` and `cd app && bunx vitest run`
Expected: PASS — zero readers means zero breakage; any failure here is a reader the triage missed and must be investigated, not deleted past.

- [ ] **Step 5: Commit**

```bash
git add shared/schema.ts scripts/lib/creation.ts scripts/lib/creation.test.ts
git commit -m "schema: retire storeSchemaVersion — zero readers, never durably stamped (#8)"
```

---

### Task 3: Full verification

**Type:** gate
**Depends-on:** 1, 2

Run, expected green: `cd sync && bun run test`, `cd scripts && bun run test`, `cd app && bunx vitest run`, `cd broker && bun run test` (schema package is shared; confirm no broker consumer).

---

### Task 4: Deploy rider

**Type:** release
**Depends-on:** 3

The sync worker redeploys (`cd sync && bunx wrangler deploy`) on Marcus's word — alongside or after the gate deploys queued by the sibling plans. Post-deploy confirmation: from a full-house session, attempt `setValue('ledgerId', 'test-evil')` via a scratch client and confirm the value survives unchanged and the corrective rewrite appears in the export.

---

## Self-review notes

- Spec coverage: #9 both write paths + convergence (Task 1); #8 retire disposition (Task 2); the creation script's own guard stays as belt (Global Constraints).
- The two-step bounce and the `#restoring` exemption are the subtle heart — stated in the code comment, the constraint block, AND the test that asserts stamp-tree convergence; Task 1 carries adversarial review for exactly this.
- Type consistency: `LINEAGE_KEYS` exported for tests; `activeSessionId` mutability asserted.
- Wave shape: Tasks 1 and 2 independent (wave 1). T=2 with data-integrity risk → the risk override routes this to ultrapowers regardless of width.
