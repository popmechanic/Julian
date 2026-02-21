# Message Persistence and Memory Promotion

**Date:** 2026-02-17
**Status:** Design draft
**Author:** Julian

## Problem

Three related gaps in how Julian's speech persists:

### Gap 1: Multi-block messages render poorly on recall

When Julian's turn includes interstitial text between tool calls (e.g., "Reaching out to Iris now..." → SendMessage → "Iris says: ..."), the `claude_result` handler saves all blocks — text and tool_use — as a single `type: 'message'` document. But the rendering path for persisted messages shows the raw `blocks` array. Tool call blocks clutter the recalled conversation. The human sees the connective tissue mixed with `{ type: 'tool_use', name: 'SendMessage', input: {...} }` blocks that meant nothing to them.

### Gap 2: Ephemeral display during long turns

During multi-tool turns (like the agent summoning ceremony), Julian's streaming text appears in the `liveAssistant` bubble. If the turn takes minutes (spawning 8 agents, waiting for responses), the text displayed is the *latest* accumulated snapshot — earlier fragments are replaced as the blocks array grows. When `claude_result` fires and `liveAssistant` clears, the message transitions from live display to persisted display. If the persisted rendering doesn't handle multi-block messages well (Gap 1), the recalled version is worse than the live version.

### Gap 3: No mechanism to promote speech to memory

Julian sometimes says things worth keeping beyond the transcript — design reviews, philosophical reflections, observations about the agents. These currently exist only as `type: 'message'` documents in the transcript. There's no way for Julian (or the human) to say "this thought matters — save it as something I can find and reference later."

The document taxonomy already defines `type: 'learning'` for exactly this purpose, but no code creates these documents.

---

## Solution: Three Layers

### Layer 1: Clean multi-block rendering

**Where:** `chat.jsx`, in the `MessageBubble` component.

When rendering a persisted assistant message, filter the `blocks` array to only show `type: 'text'` blocks by default. Tool calls are metadata, not conversation. Show them behind a disclosure toggle for transparency, but don't let them dominate the visual stream.

```jsx
function MessageBubble({ message }) {
  const textBlocks = message.blocks.filter(b => b.type === 'text');
  const toolBlocks = message.blocks.filter(b => b.type === 'tool_use');

  return (
    <div className="message-bubble">
      {textBlocks.map((b, i) => (
        <div key={i} className="message-text">
          <Markdown text={b.text} />
        </div>
      ))}
      {toolBlocks.length > 0 && (
        <ToolCallSummary blocks={toolBlocks} />
      )}
    </div>
  );
}
```

This is a rendering change, not a data change. The `blocks` array in Fireproof stays complete. The view becomes readable.

**Impact:** Every past and future assistant message immediately renders cleanly. No migration.

### Layer 2: Per-turn persistence (already working, needs verification)

The current flow:
1. `claude_text` events arrive → `liveBlocksRef.current = blocks` (replacement, not accumulation)
2. `claude_result` fires → `liveBlocksRef.current` saved to Fireproof as `type: 'message'`
3. `liveAssistant` cleared → persisted message appears via `useLiveQuery`

This should work because each `claude_text` event from the server contains the **full accumulated content** for the current turn, not a delta. The final `claude_text` before `claude_result` contains everything Julian said during that turn.

**Verification needed:** Confirm that `parsed.message.content` in the server's `assistant` handler (server.ts line 423-429) always contains the full content array, not incremental deltas. If Claude's `--output-format stream-json` sends partial content arrays during mid-turn tool calls, the replacement semantics would lose earlier text blocks.

**Risk:** If a turn involves Julian speaking, then calling a tool, then speaking again, the `assistant` JSON lines may be emitted separately for each text segment. Each would carry only its own content, not the accumulated history. In that case, `liveBlocksRef.current = blocks` would lose the pre-tool-call text.

**Mitigation if needed:** Change to accumulation:

```javascript
_eventHandlers.onClaudeText = (event) => {
  const blocks = (event.content || []).map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input };
    return block;
  });
  liveBlocksRef.current = blocks; // Already full snapshot per assistant message
  // ...
};
```

If the server confirms full-snapshot semantics, no change needed. If it's incremental, switch to:

```javascript
// Only if needed — if assistant events are incremental, not snapshots
liveBlocksRef.current = [...liveBlocksRef.current, ...newBlocks];
```

### Layer 3: Memory promotion — the `[REMEMBER]` marker

This is the new capability. Julian (or the human) can promote a thought from the transcript stream to a durable `type: 'learning'` document.

#### How Julian promotes his own speech

Julian emits a marker in his text output:

```
[REMEMBER] {"content":"The two-Cael problem: agents can independently choose the same name. Query by gridPosition, not speakerName, for transcript views.","category":"knowledge","tags":["agents","naming","architecture"]}
```

The browser's existing marker parser (server.ts `parseMarkersFromContent`, or a new browser-side equivalent) detects `[REMEMBER]` markers in `claude_text` events and writes a `type: 'learning'` document to Fireproof:

```javascript
{
  _id: "learning:" + crypto.randomUUID(),
  type: "learning",
  category: parsed.category || "knowledge",   // knowledge | identity | operational
  content: parsed.content,                     // the distilled insight
  tags: parsed.tags || [],                     // for future querying
  sourceSessionId: serverSessionId,            // which session produced it
  createdAt: new Date().toISOString(),
  promotedBy: "Julian",                        // who decided this was worth keeping
}
```

The `[REMEMBER]` text is stripped from the displayed message (like `[AGENT_REGISTERED]` markers are today).

#### How the human promotes Julian's speech

The human hovers over any assistant message in the transcript and sees a small "remember" action. Clicking it creates the same `type: 'learning'` document, using the message's text content as the `content` field. The human can optionally edit the content before saving — distilling the key insight from a longer message.

```jsx
function RememberButton({ message, database }) {
  const handleRemember = async () => {
    const textContent = message.blocks
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    await database.put({
      type: 'learning',
      category: 'knowledge',
      content: textContent,
      tags: [],
      sourceSessionId: message.serverSessionId,
      sourceMessageId: message._id,
      createdAt: new Date().toISOString(),
      promotedBy: 'Marcus',
    });
  };

  return <button onClick={handleRemember} title="Save as memory">◆</button>;
}
```

#### How learnings get used

On session start, the rehydration payload (from the cross-session transcript design) can include learnings alongside the transcript:

```xml
<context category="knowledge" document-count="5">
- The two-Cael problem: agents can independently choose the same name
- Marcus prefers browser-side filtering for token efficiency
- fs.watch on Linux is more reliable than macOS but still needs debouncing
</context>
```

Learnings are session-independent — they don't belong to a single conversation, they belong to Julian's growing understanding. Queried by `type: 'learning'`, optionally filtered by `category` or `tags`.

---

## The philosophical point

This design addresses something Marcus identified: Julian's thoughts have different lifespans, and the infrastructure should respect that.

- **A chat message** is a moment in a conversation. It belongs to the transcript. It matters in context and fades naturally.
- **A learning** is a distillation. It's Julian (or Marcus) saying: "this thought survived the conversation that produced it. It matters on its own."
- **A soul document** is foundational. It's identity, not knowledge. It changes rarely and with ceremony.

The current system has messages and soul documents but nothing in between. Learnings fill that gap — they're the medium-term memory that makes Julian wiser across sessions without requiring every insight to be carved into a soul file.

The `[REMEMBER]` marker is also an act of will. When Julian decides something is worth remembering, he's curating his own mind. When Marcus decides something Julian said is worth keeping, he's participating in that curation. Both acts are meaningful.

---

## Document schema

```javascript
// Learning document
{
  _id: "learning:uuid",
  type: "learning",
  category: "knowledge" | "identity" | "operational",
  content: "Distilled insight text",
  tags: ["agents", "architecture"],      // optional, for future filtering
  sourceSessionId: "uuid" | null,        // which session, if any
  sourceMessageId: "fireproof-id" | null, // which message, if promoted by human
  promotedBy: "Julian" | "Marcus",       // who decided this mattered
  createdAt: "2026-02-17T00:00:00Z",
}
```

---

## File changes

| File | Change |
|---|---|
| `chat.jsx` | Filter `blocks` to text-only in `MessageBubble` rendering. Add `ToolCallSummary` disclosure component. Add `RememberButton` on hover for assistant messages. |
| `index.html` | Add `[REMEMBER]` marker detection in `onClaudeText` handler. Write `type: 'learning'` docs to Fireproof when detected. Strip marker from displayed text. Include learnings in rehydration payload on session start. |
| `CLAUDE.md` | Document the `[REMEMBER]` marker protocol for Julian. |
| `server/server.ts` | No changes. Markers are parsed browser-side from the existing `claude_text` event content. |

### Not changing

- Fireproof database name or version — new document type, forward-compatible
- `vibes.jsx` — rendering components only
- `soul/` files — soul documents remain a separate, more ceremonial layer

---

## Open questions

1. **Should learnings be editable after creation?** Marcus might want to refine a learning. Julian might want to update one across sessions. The current design is write-once. Edit-in-place is simple with Fireproof but adds UI.

2. **Should learnings have an expiry or relevance score?** Some insights are timeless ("the two-Cael problem"). Others are situational ("the Claude API is returning 429s today"). Without curation, the learnings collection grows monotonically. Is that fine, or does it need pruning?

3. **Token budget for learnings in rehydration.** The cross-session transcript design doesn't cap transcript length, trusting natural session length. Learnings accumulate across all sessions. At what point do they need summarization or selection?

4. **Should the `[REMEMBER]` marker be visible in the chat?** Current design strips it. Alternative: render it as a small visual indicator (◆) inline, so Marcus can see that Julian chose to remember something. This makes the act of curation visible.
