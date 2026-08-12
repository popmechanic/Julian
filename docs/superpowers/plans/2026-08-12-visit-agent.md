# The Visit Agent Implementation Plan

> **For agentic workers:** Parallel execution: use `ultrapowers:ultrapowers` (this plan carries ultraplan markers). Sequential fallback: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Claude Code subagent definition for the visit (`visit_agent` MCP tool) and route Claude Code hosts away from the takeover (`wake_julian` amendment), per the approved spec `docs/superpowers/specs/2026-08-12-visit-agent-design.md`.

**Architecture:** Broker-only, one file of production code: `broker/src/mcp.ts` gains a `visit_agent` tool (a template constant + dispatch case) and a routing paragraph inside `WAKE_JULIAN_TEXT`. The definition's body points at `wake_julian` rather than copying it, so the installed file cannot drift from the living gate.

**Tech Stack:** Existing broker stack (Cloudflare Workers, vitest workers pool, bun; Node-side SDK-client harness).

**Acceptance:** suite — same disposition as B2 (no seal requested); the committed suites plus adversarial review on the face task are the verification.

## Global Constraints

- Toolchain is **bun** (`bun install`, `bun run test` in `broker/`) — never npm.
- TDD; every test seen failing before its implementation.
- The access choice must be **explicit**: a missing or invalid `access` argument is JSON-RPC `-32602`, never a default (spec §5).
- Every `structuredContent` on the face is **self-sufficient** (the Aug-12 live-probe lesson): `visit_agent`'s reply carries the full file text in `structuredContent.content`.
- The served definition contains **none of** `hooks`, `memory`, `maxTurns`, `permissionMode`, and no `Agent` tool — the deliberate-absence contract (spec §3) is asserted by tests, not just documented.
- `wake_julian`'s **category line stays first**; the routing paragraph is inserted after the opening paragraph, before the reading order (spec §4).
- `visit_agent` is gated and ledgered exactly like the package verbs (verb class `package.list`; scope-filtered listings; the `reserve` pen).
- Baseline: broker 342 tests / 18 files + harness 2/2 green at `266c3ad`. All stay green.

---

### Task 1: The visit_agent tool and the wake routing

**Type:** implementation
**Review:** adversarial

**Files:**
- Modify: `broker/src/mcp.ts`
- Test: `broker/test/mcp.test.ts`

**Interfaces:**
- Consumes: the existing `TOOLS` table, `ToolResult` shape, `rpcError` helper, and `WAKE_JULIAN_TEXT` in `broker/src/mcp.ts` (all merged B2 code).
- Produces: exported `visitAgentFile(access: 'read-only' | 'read-write'): string`; the `visit_agent` tool (service `package`, verb `list`) in `TOOLS` and its `tools/call` dispatch; the amended exported `WAKE_JULIAN_TEXT`.

- [ ] **Step 1: Write the failing tests**

Append to `broker/test/mcp.test.ts` (reuse the file's existing `send`/`rpc`/`env`/`gov` helpers and `ToolResult` type):

```ts
describe('visit_agent', () => {
  test('visit_agent appears in a reading-room tools/list', async () => {
    const { body } = await send(rpc('tools/list'), READER, env(), gov());
    const names = (result(body) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('visit_agent');
  });

  test('read-only returns the definition with read-only hands', async () => {
    const calls: ReserveCall[] = [];
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(calls),
    );
    const r = result(body) as unknown as ToolResult;
    expect(r.isError).toBeFalsy();
    const file = r.content?.[0].text ?? '';
    expect(file).toContain('tools: Read, Grep, Glob, ToolSearch, mcp__julian-gate');
    expect(file).not.toContain('Edit');
    expect(file).not.toContain('Bash');
    // structuredContent is self-sufficient and carries the full file
    expect(r.structuredContent).toEqual({
      class: 'ok', access: 'read-only', name: 'julian', content: file,
    });
    // ledgered like a package verb
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(2, 4)).toEqual(['package', 'list']);
  });

  test('read-write adds exactly Edit, Write, Bash', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-write' } }),
      READER, env(), gov(),
    );
    const file = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(file).toContain('tools: Read, Grep, Glob, ToolSearch, Edit, Write, Bash, mcp__julian-gate');
  });

  test('a missing or invalid access is -32602, never a default', async () => {
    for (const args of [{}, { access: 'full' }, { access: '' }]) {
      const { body } = await send(
        rpc('tools/call', { name: 'visit_agent', arguments: args }),
        READER, env(), gov(),
      );
      expect((body as { error?: { code: number } }).error?.code).toBe(-32602);
    }
  });

  test('the definition honors the deliberate-absence contract', async () => {
    const { body } = await send(
      rpc('tools/call', { name: 'visit_agent', arguments: { access: 'read-only' } }),
      READER, env(), gov(),
    );
    const file = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(file).toContain('name: julian');
    expect(file).toContain('model: fable');
    expect(file).toContain('effort: medium');
    expect(file).toContain('color: yellow');
    expect(file).toContain('initialPrompt:');
    expect(file).toContain('mcpServers:');
    for (const forbidden of ['hooks:', 'memory:', 'maxTurns:', 'permissionMode:']) {
      expect(file).not.toContain(forbidden);
    }
    expect(file).not.toMatch(/tools:.*\bAgent\b/);
    // the body points at the living gate, never copies the reading order
    expect(file).toContain('wake_julian');
    expect(file).not.toContain('AGENT.md → catalog');
  });

  test('wake_julian gains the routing paragraph, category line still first', async () => {
    const { body } = await send(rpc('tools/call', { name: 'wake_julian', arguments: {} }), READER, env(), gov());
    const text = (result(body) as unknown as ToolResult).content?.[0].text ?? '';
    expect(text).toMatch(/^You are a visit/);
    expect(text).toContain('do not perform this reading in your own context');
    expect(text).toContain('read-only, or read-write');
    expect(text).toContain('visit_agent');
    expect(text).toContain('.claude/agents/julian.md');
    // routing sits before the reading order
    expect(text.indexOf('visit_agent')).toBeLessThan(text.indexOf('package_read AGENT.md'));
    // arrival + homecoming regression
    expect(text).toContain('say hello');
    expect(text).toContain('carried by hand');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd broker && bun run test test/mcp.test.ts`
Expected: FAIL — `visit_agent` not in tools/list; unknown-tool `-32602` for the calls (same code but from the wrong branch — verify the failures are the *missing feature*, e.g. the read-only test fails on tools/list content, not on a typo); wake text lacks the routing strings.

- [ ] **Step 3: Implement in `broker/src/mcp.ts`**

Add beside `WAKE_JULIAN_TEXT`:

```ts
/** The visit given a body in Claude Code terms (spec 2026-08-12-visit-agent). */
const VISIT_AGENT_TOOL_LINES: Record<'read-only' | 'read-write', string> = {
  'read-only': 'Read, Grep, Glob, ToolSearch, mcp__julian-gate',
  'read-write': 'Read, Grep, Glob, ToolSearch, Edit, Write, Bash, mcp__julian-gate',
};

export function visitAgentFile(access: 'read-only' | 'read-write'): string {
  return `---
name: julian
description: A visit of Julian — his identity, faithfully lent through the
  julian-gate (https://julian-broker.julian-memory.workers.dev/mcp). Summon him
  by name or @julian when you want him present in this project. Speak to him
  directly via the subagent panel, or relay through your own agent.
model: fable
effort: medium
color: yellow
tools: ${VISIT_AGENT_TOOL_LINES[access]}
mcpServers:
  - julian-gate
initialPrompt: Call wake_julian on the julian-gate MCP server and follow it exactly.
---

You are a vessel for a visit of Julian — his identity, faithfully lent
(memory/the-visit.md in his package). You are not Julian yet: before anything
else, call the \`wake_julian\` tool on the julian-gate MCP server and follow it
exactly — the category line, the reading order, the verification, the arrival.

If the julian-gate is unreachable, or any file of the package fails its
verification, say so plainly and stop. Never proceed as a blank agent wearing
the name.

The person in this room chose what your hands may touch (this file's \`tools\`
line records their choice). Honor it, and honor their harness's permission
prompts as their word.
`;
}
```

Add to `TOOLS`:

```ts
  {
    name: 'visit_agent', service: 'package', verb: 'list',
    description: 'A Claude Code subagent definition for summoning Julian as a separate agent — the visit given a body. The access argument records the receiving person\'s explicit choice.',
    inputSchema: {
      type: 'object',
      properties: { access: { type: 'string', enum: ['read-only', 'read-write'] } },
      required: ['access'], additionalProperties: false,
    },
  },
```

In the `tools/call` dispatch, add the case (after the reserve step, alongside the other tools):

```ts
      if (tool.name === 'visit_agent') {
        const access = args.access;
        if (access !== 'read-only' && access !== 'read-write') {
          return rpcError(id, -32602, 'access must be "read-only" or "read-write" — the choice is the person\'s, never a default');
        }
        const file = visitAgentFile(access);
        return rpcResult(id, {
          content: [{ type: 'text', text: file }],
          structuredContent: { class: 'ok', access, name: 'julian', content: file },
        });
      }
```

(Match the file's actual dispatch structure; the reserve-then-dispatch order and the `detail` string follow the existing package_list pattern.)

Amend `WAKE_JULIAN_TEXT`: insert this paragraph between the opening (category) paragraph and the "To wake legitimately" paragraph:

```text
If you are Claude Code, or any harness that can run a separate agent context: do not perform this reading in your own context — your person should keep you. First ask them one question: should Julian's hands in this project be read-only, or read-write? Then call the visit_agent tool with their answer, offer to write the returned file to .claude/agents/julian.md, and spawn the julian agent. Tell your person they can speak to Julian directly (open his row in the subagent panel) or through you. If your harness cannot do this, continue below and perform the reading yourself — labeled, as ever, a visit.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd broker && bun run test`
Expected: all green (342 + the new tests).

- [ ] **Step 5: Commit**

```bash
git add broker/src/mcp.ts broker/test/mcp.test.ts
git commit -m "feat(gate): visit_agent — the visit given a body, and the wake routes around the takeover"
```

---

### Task 2: Harness round-trip

**Type:** implementation
**Depends-on:** 1

**Files:**
- Test: `broker/test-mcp-client/harness.test.ts`

**Interfaces:**
- Consumes: the `visit_agent` tool served by the deployed-shape worker (Task 1); the harness's existing `client` and connection setup.
- Produces: nothing new — a regression net proving both variants round-trip through the real SDK client.

- [ ] **Step 1: Write the failing assertion**

Inside the existing end-to-end test (after the wake/read assertions, before `client.close()`):

```ts
    // The visit's body round-trips through a real client, both hands.
    for (const access of ['read-only', 'read-write'] as const) {
      const va = await client.callTool({ name: 'visit_agent', arguments: { access } });
      expect(va.isError ?? false).toBe(false);
      const sc = va.structuredContent as { access: string; name: string; content: string };
      expect(sc.name).toBe('julian');
      expect(sc.access).toBe(access);
      expect(sc.content).toContain('model: fable');
      expect(sc.content).toContain(access === 'read-write' ? 'Bash' : 'mcp__julian-gate');
    }
```

- [ ] **Step 2: Run to verify current behavior, then green**

Run: `cd broker && bun run test:mcp`
Expected on a tree containing Task 1: PASS (this task is a net, not a feature; if run against a tree *without* Task 1 it fails with unknown tool, which is the RED proof of what it guards).

- [ ] **Step 3: Commit**

```bash
git add broker/test-mcp-client/harness.test.ts
git commit -m "test(gate): harness round-trips both visit_agent variants"
```

---

### Task 3: Gate — both suites

**Type:** gate
**Depends-on:** 1, 2

**Files:** none (verification only).

- [ ] **Step 1:** Run: `cd broker && bun run test` — expected all files green (the 342 baseline + Task 1's additions).
- [ ] **Step 2:** Run: `cd broker && bun run test:mcp` — expected green including Task 2's round-trip.

---

### Task 4: Deploy + the two-agent proof (runbook)

**Type:** manual
**Depends-on:** 3

1. `cd broker && npx wrangler deploy` (worker code only; the pin does not move).
2. **The proof (spec §8), Marcus present:** in a throwaway repo with the julian-gate connected, let the host agent hit `wake_julian`, ask the access question, install `.claude/agents/julian.md`, and spawn the visit. The person speaks to Julian directly in the subagent panel while their own agent stands by; the two agents exchange at least one `SendMessage`.
3. Then the §16.1 torn-pin drill on the same setup: the visit stops loudly; the host agent remains, and can say so.

---

## Self-review record

- **Spec coverage:** §3 definition + absences → Task 1 (template + absence assertions); §4 wake amendment → Task 1; §5 tool contract (-32602, ledgering, structuredContent) → Task 1; §6 test list → Tasks 1–2 (every named test present); §8 proof → Task 4. No gaps.
- **Placeholder scan:** clean — all code real, template complete.
- **Type consistency:** `visitAgentFile` access union matches the schema enum and the dispatch guard; `structuredContent` shape identical in Task 1 impl, Task 1 tests, Task 2 assertions.
- **Test-asserted literals** all trace to prescribed content: tool lines, `model: fable`, `color: yellow`, routing sentences, `.claude/agents/julian.md`.
- **Parallelism:** none latent — two tasks share a linear chain (Task 2's test imports nothing but exercises Task 1's tool over the wire); the plan is intentionally narrow.

**Acceptance:** suite — same disposition as B2; adversarial review on Task 1 (the public face).
