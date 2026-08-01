// app/src/lib/tail.test.ts
import { describe, expect, test } from "vitest";
import { createStore } from "tinybase";
import { createStreamStore } from "julian-shared/schema";
import { selectTail, TAIL_MAX_MESSAGES, TAIL_MAX_CHARS } from "./tail";

function storeWith(rows: Array<Record<string, unknown>>) {
  const store = createStore();
  rows.forEach((r, i) => store.setRow("messages", `m${i}`, r as never));
  return store;
}

describe("selectTail", () => {
  test("returns chat rows oldest-first with wire shape", () => {
    const store = storeWith([
      { kind: "chat", role: "assistant", speakerName: "Julian", text: "second", ts: 200, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "Marcus", text: "first", ts: 100, sessionId: "s" },
    ]);
    expect(selectTail(store)).toEqual([
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "first", ts: 100 },
      { role: "assistant", speakerType: "assistant", speakerName: "Julian", text: "second", ts: 200 },
    ]);
  });
  test("filters non-chat rows and empty text", () => {
    const store = storeWith([
      { kind: "chat", role: "user", speakerName: "M", text: "keep", ts: 1, sessionId: "s" },
      { kind: "system", role: "user", speakerName: "M", text: "drop", ts: 2, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: "", ts: 3, sessionId: "s" },
    ]);
    expect(selectTail(store).map((m) => m.text)).toEqual(["keep"]);
  });
  test("caps at TAIL_MAX_MESSAGES, keeping the newest", () => {
    const rows = Array.from({ length: TAIL_MAX_MESSAGES + 20 }, (_, i) => ({
      kind: "chat", role: "user", speakerName: "M", text: `t${i}`, ts: i + 1, sessionId: "s",
    }));
    const tail = selectTail(storeWith(rows));
    expect(tail).toHaveLength(TAIL_MAX_MESSAGES);
    expect(tail[tail.length - 1].text).toBe(`t${TAIL_MAX_MESSAGES + 19}`);
    expect(tail[0].text).toBe("t20");
  });
  test("caps at TAIL_MAX_CHARS, trimming whole oldest messages", () => {
    const big = "x".repeat(TAIL_MAX_CHARS - 10);
    const store = storeWith([
      { kind: "chat", role: "user", speakerName: "M", text: "old-dropped", ts: 1, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: big, ts: 2, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: "newest", ts: 3, sessionId: "s" },
    ]);
    const tail = selectTail(store);
    expect(tail.map((m) => m.text)).toEqual([big, "newest"]); // whole message dropped, none truncated
  });
  test("empty store yields empty tail", () => {
    expect(selectTail(storeWith([]))).toEqual([]);
  });
  test("oversized newest message degrades instead of emptying the tail", () => {
    const huge = "y".repeat(TAIL_MAX_CHARS + 5000);
    const store = storeWith([
      { kind: "chat", role: "user", speakerName: "M", text: "older-1", ts: 1, sessionId: "s" },
      { kind: "chat", role: "user", speakerName: "M", text: "older-2", ts: 2, sessionId: "s" },
      { kind: "chat", role: "assistant", speakerName: "Julian", text: huge, ts: 3, sessionId: "s" },
    ]);
    const tail = selectTail(store);
    expect(tail).toHaveLength(1);
    expect(tail[0].text).toHaveLength(TAIL_MAX_CHARS);
    expect(tail[0].role).toBe("assistant");
    expect(tail[0].speakerType).toBe("assistant");
    expect(tail[0].speakerName).toBe("Julian");
    expect(tail[0].ts).toBe(3);
  });
  test("real store shape via createStreamStore: row without explicit kind still appears (schema defaults kind to 'chat')", () => {
    const store = createStreamStore("fixture");
    store.setRow("messages", "m1", {
      sessionId: "s",
      role: "user",
      speakerName: "Marcus",
      text: "hello",
      ts: 100,
    } as never);
    expect(selectTail(store as never)).toEqual([
      { role: "user", speakerType: "human", speakerName: "Marcus", text: "hello", ts: 100 },
    ]);
  });
});
