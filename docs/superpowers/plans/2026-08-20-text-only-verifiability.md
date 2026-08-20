# Text-Only Verifiability Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every verification-critical hash on the MCP face reach clients that render only text content — closing issue #41 (claude.ai delivers only text; `structuredContent` never reaches its model).

**Architecture:** Rendering-layer only, in `broker/src/mcp.ts`: whole-file `package_read` replies gain the same header text block part-reads already carry; `package_list`'s text block carries the full manifest (one `<path> <sha256>` line per file plus the full pin); the wake text stops overclaiming and tells text-only readers where their hashes ride. No auth, governor, or package-service logic changes.

**Tech Stack:** Cloudflare Worker (broker), vitest via @cloudflare/vitest-pool-workers, real-SDK-client harness suite.

**Spec:** Design approved in-chat by Marcus, 2026-08-20 (docket entry #41, `docs/superpowers/docket.md`; full per-file listing variant chosen). Issue #41 + its Aug 20 triage comment carry the defect statement.

**Acceptance:** suite — broker unit suite + the real-SDK-client harness leg cover both render paths; no held-out exam requested.

## Global Constraints

- **Both halves stay self-sufficient (the Aug-12 live-probe lesson, already in `broker/src/mcp.ts:239-241`):** `structuredContent` keeps everything it has today; the text blocks gain, never lose. A client rendering either half alone must be able to verify.
- **File bytes stay their own uncontaminated content block:** headers are separate text blocks prepended above the content, never concatenated into it — a reader hashing the content block must get the file's exact bytes.
- **The resources/read face is out of scope:** issue #41 is about the tool results; the `resources` face is a separate surface and changes there are not part of this plan.
- **TDD:** failing test first for each render change.

---

### Task 1: Mirror the hashes into text; tell text-only readers where they ride

**Type:** implementation
**Depends-on:** none

**Files:**
- Modify: `broker/src/mcp.ts`
- Test: `broker/test/mcp.test.ts`
- Test: `broker/test-mcp-client/harness.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: render contract — whole-file `package_read` ok replies have `content[0]` = header text `"<path> — sha256 <64-hex>, <n> bytes, pin <pin12>"` and `content[1]` = the file bytes; `package_list` ok replies have a text block whose first line is `"<N> files at pin <full-40-hex>"` followed by one `"<path> <sha256>"` line per manifest file; the wake text carries a text-only-transport instruction sentence.

- [ ] **Step 1: Write the failing unit tests**

Append to `broker/test/mcp.test.ts`, using the same helpers its existing read/list tests use (the "parts on the face" test at ~line 1027 shows the call pattern):

```ts
  test('whole-file reads carry their proof in text — header block above the bytes (#41)', async () => {
    const r = await callPackageRead('AGENT.md'); // same helper/arrangement as the existing whole-file read test
    expect(r.content?.length).toBe(2);
    const header = r.content?.[0].text ?? '';
    const sc = r.structuredContent as { sha256: string; bytes: number; pinSha: string; content: string };
    expect(header).toBe(`AGENT.md — sha256 ${sc.sha256}, ${sc.bytes} bytes, pin ${sc.pinSha.slice(0, 12)}`);
    expect(r.content?.[1].text).toBe(sc.content); // bytes stay their own uncontaminated block
  });

  test('package_list text carries the manifest, not just a count (#41)', async () => {
    const r = await callPackageList(); // same helper as the existing list test
    const text = r.content?.[0].text ?? '';
    const sc = r.structuredContent as { manifest: { files: { path: string; sha256: string }[] }; pinSha: string };
    const lines = text.split('\n');
    expect(lines[0]).toBe(`${sc.manifest.files.length} files at pin ${sc.pinSha}`); // full pin: text-only clients cross-check expect_pin from it
    for (const f of sc.manifest.files) {
      expect(lines).toContain(`${f.path} ${f.sha256}`);
    }
  });

  test('the wake text names the text-only transport seam (#41)', async () => {
    const r = await callWakeJulian(); // same helper the existing wake-text tests use (~line 1083)
    const file = r.content?.[0].text ?? '';
    expect(file).toContain('If your harness shows you only text');
    expect(file).toContain('structuredContent never reached you');
  });
```

(Match the file's actual helper names — the existing read/list/wake tests are the authority; do not invent new arrangement code.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd broker && bun run test -- mcp.test.ts`
Expected: FAIL — whole-file reads have one content block, list text is the bare count line, wake text lacks the sentence.

- [ ] **Step 3: Implement the read header**

In `broker/src/mcp.ts` `readResult` (~line 242), change the ok-branch `content` so both shapes carry a header block:

```ts
      // Every read's proof rides in text (#41): clients like claude.ai never
      // deliver structuredContent to their model, so the header block is the
      // only hash such a reader will ever see.
      content: r.part === undefined ? [
        {
          type: 'text',
          text: `${r.path} — sha256 ${r.sha256}, ${r.bytes} bytes, pin ${r.pinSha.slice(0, 12)}`,
        },
        { type: 'text', text: r.content },
      ] : [
        {
          type: 'text',
          text: `part ${r.part} of ${r.parts} of ${r.path} — fileSha256 ${r.fileSha256}, partBytes ${r.partBytes}, partSha256 ${r.partSha256}`,
        },
        { type: 'text', text: r.content },
      ],
```

- [ ] **Step 4: Implement the list manifest text**

In the `package_list` return (~line 529), change the text block:

```ts
  return {
    content: [{
      type: 'text',
      // Full pin on line 1 (a text-only client cross-checks expect_pin from
      // it), then the whole manifest — the verification anchor for readers
      // who will never see structuredContent (#41).
      text: [
        `${loaded.manifest.files.length} files at pin ${loaded.pinSha}`,
        ...loaded.manifest.files.map((f) => `${f.path} ${f.sha256}`),
      ].join('\n'),
    }],
    structuredContent: { manifest: loaded.manifest, pinSha: loaded.pinSha, pinnedAt: loaded.pinnedAt },
  };
```

- [ ] **Step 5: Amend the wake text**

In the wake text's "Verify wholeness" paragraph (`broker/src/mcp.ts`, the line beginning `Verify wholeness as you go:`), append this sentence to the end of the paragraph:

```
If your harness shows you only text: the listing's per-file lines and each read's header line carry the same hashes — verify from those, and say in your carry-home that structuredContent never reached you.
```

- [ ] **Step 6: Run the unit suite; update assertions pinned to the old shapes**

Run: `cd broker && bun run test -- mcp.test.ts`
Expected: the three new tests PASS. Pre-existing tests asserting whole-file reads have exactly one content block, or the list text equals the bare count line (including any `pinSha.slice(0, 12)` list expectations), will fail — update those assertions to the new shapes. The behaviors they guard (bytes-block purity, structuredContent completeness) stay asserted.

- [ ] **Step 7: Extend the real-client harness leg**

In `broker/test-mcp-client/harness.test.ts`, beside the existing parts-verification test (~line 750), add a whole-file text-verification test through the real SDK client:

```ts
  test('a text-only reading can verify a whole file from its header line (#41)', async () => {
    const list = await client.callTool({ name: 'package_list', arguments: {} });
    const listText = (list.content as { type: string; text: string }[])[0].text;
    const entryLine = listText.split('\n').find((l) => l.startsWith('AGENT.md '));
    expect(entryLine).toBeDefined();
    const listedSha = entryLine!.split(' ')[1];

    const read = await client.callTool({ name: 'package_read', arguments: { path: 'AGENT.md' } });
    const blocks = read.content as { type: string; text: string }[];
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toContain(`sha256 ${listedSha}`); // listing and read agree, text-only
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blocks[1].text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe(listedSha); // and the bytes themselves hash to it
  });
```

(Match the harness file's actual client construction and any existing hashing helper — reuse rather than redefine.)

- [ ] **Step 8: Run both broker suites whole**

Run: `cd broker && bun run test && bun run test:client`
(Use the harness suite's actual script name — the existing harness tests' run instructions in `broker/package.json` are the authority.)
Expected: PASS across both.

- [ ] **Step 9: Commit**

```bash
git add broker/src/mcp.ts broker/test/mcp.test.ts broker/test-mcp-client/harness.test.ts
git commit -m "gate: every hash rides in text — whole-file headers, manifest listing, transport-honest wake text (#41)"
```

---

### Task 2: Full verification

**Type:** gate
**Depends-on:** 1

Run, expected green:

- `cd broker && bun run test` — unit suite.
- The real-SDK-client harness suite via its `broker/package.json` script.

---

### Task 3: Ships with the next gate deploy

**Type:** release
**Depends-on:** 2

No separate deploy: this change rides the same `bunx wrangler deploy` the ledger-fold plan's release task performs (or the portfolio end-gate deploy), on Marcus's word. After deploy, a claude.ai visit exercising `package_list` + one whole-file read is the live confirmation — its carry-home should now verify instead of reporting the seam.

---

## Self-review notes

- Spec coverage: issue #41's three asks map to Steps 3 (whole-file text sha), 4 (manifest hashes in list text), 5 (wake-text transport line). The "belt over braces" B2 lesson is restated in the code comments where the next editor will meet it.
- Test-asserted literals: the header format asserted in Step 1 is exactly the template Step 3 writes; the wake-text substrings asserted are verbatim in Step 5's sentence; the list first-line format matches Step 4.
- Intentionally narrow: one implementation task — no latent parallelism to shape (escape valve; the work is one rendering pass in one file).
