# Pin-Bump Refusal Labeling Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `pinBump` from labeling GitHub's refusals as facts about the repo — only a 404 earns "sha unknown"; rate limits say so and suggest the cure — and honor an optional `GITHUB_TOKEN` on the compare call (issue #42).

**Architecture:** One branch in `broker/src/as/admin.ts` splits three ways on the compare status (403/429 → 429 rate-limit refusal; 404 → 409 "unknown to the repo"; other non-ok → 502 naming the status, pin unchanged). An optional `GITHUB_TOKEN` secret, when present, rides the compare request as an Authorization header — raw fetches stay unauthenticated (public repo, separate budget). Installing the secret is a deploy-time operator choice; absent means today's behavior.

**Tech Stack:** Cloudflare Worker (broker), vitest + `fetchMock` interception (the existing `POST /pin-bump` suite in `broker/test/admin.test.ts:1082` has the full arrangement).

**Spec:** Design approved in the Aug 20 sweep with Marcus (docket entry #42, `docs/superpowers/docket.md`); issue #42 + its Aug 20 triage comment carry the defect record (four mislabeled attempts in one night, Aug 13).

**Acceptance:** suite — the pin-bump vitest suite covers every branch; no held-out exam requested.

## Global Constraints

- **A refusal is never labeled as a fact:** no message may claim something about the repo that GitHub did not assert. "Unknown to the repo" is reserved for an actual 404.
- **The pin never moves on an unproven sha:** every new branch returns without touching KV, exactly like the existing failure arms.
- **The token is optional and never logged:** `GITHUB_TOKEN?: string` — absent env behaves byte-identically to today on the happy path; the token value appears in no error message, no ledger row, no log.
- **TDD:** failing test first for each new branch.

---

### Task 1: Split the compare-status branch; honor an optional GITHUB_TOKEN

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `broker/src/as/admin.ts:585`
- Modify: `broker/src/env.ts`
- Test: `broker/test/admin.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `POST /pin-bump` error contract — compare 403/429 → HTTP 429 `{ error: 'GitHub refused the proof request for <sha> (rate limit) — retry later, or install GITHUB_TOKEN to authenticate the compare' }`; compare 404 → HTTP 409 `{ error: 'sha <sha> is unknown to the repo' }` (unchanged text); other compare non-ok → HTTP 502 `{ error: 'GitHub answered <status> proving <sha> — pin unchanged' }`. `Env` gains `GITHUB_TOKEN?: string`.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('POST /pin-bump', ...)` block of `broker/test/admin.test.ts`, reusing its helpers (`pinKv`, `pinBumpEnv`, `bumpReq`, `fetchMock`, `GITHUB`, `COMPARE_PREFIX`, `SHA`, and whatever credential header its passing tests send — copy the authed arrangement from the nearest green pin-bump test verbatim):

```ts
  test('a rate-limited compare is a refusal, not a fact about the repo (#42)', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(403, 'rate limited');
    const res = await worker.fetch(bumpReq(AUTHED), env); // AUTHED = the credential headers the passing tests use
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('rate limit');
    expect(body.error).not.toContain('unknown to the repo');
    expect(await kv.get(PIN_KEY)).toBeNull(); // pin untouched
  });

  test('only a 404 earns "unknown to the repo" (#42)', async () => {
    const { env } = pinBumpEnv();
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(404, 'not found');
    const res = await worker.fetch(bumpReq(AUTHED), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(`sha ${SHA} is unknown to the repo`);
  });

  test('any other compare status is named honestly and changes nothing (#42)', async () => {
    const kv = pinKv();
    const { env } = pinBumpEnv(kv);
    fetchMock.get(GITHUB).intercept({ path: `${COMPARE_PREFIX}${SHA}` }).reply(500, 'boom');
    const res = await worker.fetch(bumpReq(AUTHED), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(`GitHub answered 500 proving ${SHA} — pin unchanged`);
    expect(await kv.get(PIN_KEY)).toBeNull();
  });

  test('GITHUB_TOKEN, when present, rides the compare request — and only the compare request (#42)', async () => {
    const { env } = pinBumpEnv();
    (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN = 'ghp_test_token';
    let sawAuth: string | null = null;
    fetchMock
      .get(GITHUB)
      .intercept({ path: `${COMPARE_PREFIX}${SHA}` })
      .reply(200, function (this: unknown, req: { headers: Record<string, string> }) {
        sawAuth = req.headers['authorization'] ?? null;
        return JSON.stringify({ status: 'behind' });
      });
    // Let the flow proceed past compare so the call actually fires; the
    // manifest arm can 502 — this test only asserts the header.
    await worker.fetch(bumpReq(AUTHED), env);
    expect(sawAuth).toBe('Bearer ghp_test_token');
  });
```

(If `fetchMock`'s reply-callback header access differs in this undici version, capture the header with the mechanism the suite already uses elsewhere; the assertion — `Bearer ghp_test_token` on the compare call — is the contract. Add a companion assertion in one existing raw-fetch test that no Authorization header reaches `RAW`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && bun run test -- admin.test.ts`
Expected: FAIL — today 403/500 both return the 409 "unknown" message, and no token header is sent.

- [ ] **Step 3: Implement**

In `broker/src/env.ts`, add to the `Env` interface beside the other optional secrets:

```ts
  GITHUB_TOKEN?: string;      // optional: authenticates the pin-bump compare call (rate-limit ceiling); never logged
```

In `broker/src/as/admin.ts`, amend the compare fetch and its status handling:

```ts
  let compare: Response;
  try {
    // env.PIN_COMPARE_BASE: the compare-endpoint root from wrangler.toml
    // (repo hardcoded there, e.g. …/repos/popmechanic/Julian/compare/main...);
    // env-addressable so the CI harness can point it at a fixture server.
    compare = await fetch(`${env.PIN_COMPARE_BASE}${sha}`, {
      headers: {
        'User-Agent': 'julian-gate',
        Accept: 'application/vnd.github+json',
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    });
  } catch {
    return json({ error: `could not reach GitHub to prove ${sha} is on main` }, 502);
  }
  // A refusal is never labeled as a fact about the repo (#42): four attempts
  // on drills night read "unknown sha" for a sha that was on main the whole
  // time, because the shared-egress anonymous budget 403'd.
  if (compare.status === 403 || compare.status === 429) {
    return json({
      error: `GitHub refused the proof request for ${sha} (rate limit) — retry later, or install GITHUB_TOKEN to authenticate the compare`,
    }, 429);
  }
  if (compare.status === 404) return json({ error: `sha ${sha} is unknown to the repo` }, 409);
  if (!compare.ok) return json({ error: `GitHub answered ${compare.status} proving ${sha} — pin unchanged` }, 502);
```

(Everything from the `rel` check down is unchanged.)

- [ ] **Step 4: Run the suite whole**

Run: `cd broker && bun run test`
Expected: PASS — new branches green, no regressions (the existing "unknown sha" test should now intercept with an explicit 404 if it previously used another status; update that intercept if needed, since 404 is now the only status earning that message).

- [ ] **Step 5: Commit**

```bash
git add broker/src/as/admin.ts broker/src/env.ts broker/test/admin.test.ts
git commit -m "gate: pin-bump names GitHub refusals honestly; optional GITHUB_TOKEN on the compare (#42)"
```

---

### Task 2: Full verification

**Type:** gate
**Depends-on:** 1

Run, expected green: `cd broker && bun run test`.

---

### Task 3: Deploy rider + optional token install

**Type:** release
**Depends-on:** 2

Rides the next gate deploy (with the ledger-fold and text-verifiability changes), on Marcus's word. At that deploy, Marcus decides whether to install the token: `bunx wrangler secret put GITHUB_TOKEN` (a fine-grained PAT, public-repo read-only, pasted never printed — the stdin-pipe lesson from the secrets manifest applies). Absent token is a supported configuration; the honest labels alone close the mislabeling.

---

## Self-review notes

- Spec coverage: status split (Steps 1-3), token support compare-only (Step 1 test 4 + Step 3), operator-optional install (Task 3). The "availability coupling accepted, mislabeling not" line from the issue is honored: no behavior depends on the token existing.
- Test-asserted literals: every asserted error string appears verbatim in Step 3's implementation.
- Intentionally narrow: one implementation task; no latent parallelism (escape valve).
