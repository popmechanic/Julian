import { describe, expect, test, beforeEach } from "bun:test";
import {
  base64url,
  generateCodeVerifier,
  generateCodeChallenge,
  parseEnvContent,
  corsHeaders,
  parseMarkersFromContent,
  createEventLog,
  parseClaudeCredentials,
  parseSculptorCredentials,
  ServerEvent,
} from "../../server/lib";
import { createHash } from "crypto";

// ── base64url ─────────────────────────────────────────────────────────────

describe("base64url", () => {
  test("produces URL-safe output with no +, /, or = characters", () => {
    // Use a buffer that would produce all three problematic chars in standard base64
    const buf = Buffer.from([0xfb, 0xff, 0xfe, 0xfd, 0xfc, 0x3e, 0x3f]);
    const result = base64url(buf);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });

  test("produces correct length for known input", () => {
    const buf = Buffer.from("hello world");
    const result = base64url(buf);
    // "hello world" base64 = "aGVsbG8gd29ybGQ=" (16 chars), strip trailing = -> 15
    expect(result).toBe("aGVsbG8gd29ybGQ");
  });

  test("empty buffer produces empty string", () => {
    const result = base64url(Buffer.alloc(0));
    expect(result).toBe("");
  });

  test("32 random bytes produce 43-char output", () => {
    // 32 bytes -> 44 base64 chars -> strip 1 trailing = -> 43
    const buf = Buffer.alloc(32, 0xab);
    const result = base64url(buf);
    expect(result.length).toBe(43);
  });
});

// ── generateCodeVerifier ──────────────────────────────────────────────────

describe("generateCodeVerifier", () => {
  test("returns a URL-safe string", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).not.toContain("+");
    expect(verifier).not.toContain("/");
    expect(verifier).not.toContain("=");
  });

  test("returns 43-character string (32 random bytes base64url-encoded)", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBe(43);
  });
});

// ── generateCodeChallenge ─────────────────────────────────────────────────

describe("generateCodeChallenge", () => {
  test("known-answer test: SHA-256 of known verifier", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Compute expected: SHA-256 of verifier, then base64url
    const hash = createHash("sha256").update(verifier).digest();
    const expected = hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = generateCodeChallenge(verifier);
    expect(result).toBe(expected);
  });

  test("output is URL-safe", () => {
    const result = generateCodeChallenge("test-verifier-string");
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });

  test("different verifiers produce different challenges", () => {
    const a = generateCodeChallenge("verifier-a");
    const b = generateCodeChallenge("verifier-b");
    expect(a).not.toBe(b);
  });
});

// ── parseEnvContent ───────────────────────────────────────────────────────

describe("parseEnvContent", () => {
  test("empty string returns empty object", () => {
    expect(parseEnvContent("")).toEqual({});
  });

  test("lines with comments are skipped", () => {
    const result = parseEnvContent("# this is a comment\n# another comment");
    expect(result).toEqual({});
  });

  test("blank lines are skipped", () => {
    const result = parseEnvContent("\n\n  \n\n");
    expect(result).toEqual({});
  });

  test("KEY=VALUE is parsed correctly", () => {
    const result = parseEnvContent("API_KEY=secret123");
    expect(result).toEqual({ API_KEY: "secret123" });
  });

  test("value containing = is correctly parsed (split on first = only)", () => {
    const result = parseEnvContent("TOKEN=abc=def=ghi");
    expect(result).toEqual({ TOKEN: "abc=def=ghi" });
  });

  test("multiple entries are all present", () => {
    const result = parseEnvContent("KEY1=val1\nKEY2=val2\nKEY3=val3");
    expect(result).toEqual({ KEY1: "val1", KEY2: "val2", KEY3: "val3" });
  });

  test("mixed content: comments, blanks, and values", () => {
    const input = `# Config file
KEY1=value1

# Another comment
KEY2=value2

`;
    const result = parseEnvContent(input);
    expect(result).toEqual({ KEY1: "value1", KEY2: "value2" });
  });

  test("lines without = are skipped", () => {
    const result = parseEnvContent("NOEQUALS\nGOOD=value");
    expect(result).toEqual({ GOOD: "value" });
  });
});

// ── parseClaudeCredentials ────────────────────────────────────────────────

describe("parseClaudeCredentials", () => {
  test("valid data returns accessToken and expiresAt", () => {
    const data = {
      claudeAiOauth: {
        accessToken: "sk-test-token",
        expiresAt: 1700000000000,
      },
    };
    const result = parseClaudeCredentials(data);
    expect(result).toEqual({ accessToken: "sk-test-token", expiresAt: 1700000000000 });
  });

  test("missing claudeAiOauth returns null", () => {
    expect(parseClaudeCredentials({})).toBeNull();
    expect(parseClaudeCredentials({ otherKey: "value" })).toBeNull();
  });

  test("empty accessToken returns null", () => {
    const data = { claudeAiOauth: { accessToken: "", expiresAt: 123 } };
    expect(parseClaudeCredentials(data)).toBeNull();
  });

  test("missing expiresAt defaults to 0", () => {
    const data = { claudeAiOauth: { accessToken: "token-123" } };
    const result = parseClaudeCredentials(data);
    expect(result).toEqual({ accessToken: "token-123", expiresAt: 0 });
  });

  test("null input returns null", () => {
    expect(parseClaudeCredentials(null)).toBeNull();
    expect(parseClaudeCredentials(undefined)).toBeNull();
  });

  test("non-string accessToken returns null", () => {
    const data = { claudeAiOauth: { accessToken: 12345, expiresAt: 123 } };
    expect(parseClaudeCredentials(data)).toBeNull();
  });
});

// ── parseSculptorCredentials ──────────────────────────────────────────────

describe("parseSculptorCredentials", () => {
  test("valid data returns access_token and expires_at_unix_ms", () => {
    const data = {
      anthropic: {
        access_token: "sculptor-token-abc",
        expires_at_unix_ms: 1700000000000,
      },
    };
    const result = parseSculptorCredentials(data);
    expect(result).toEqual({ access_token: "sculptor-token-abc", expires_at_unix_ms: 1700000000000 });
  });

  test("missing anthropic returns null", () => {
    expect(parseSculptorCredentials({})).toBeNull();
  });

  test("empty access_token returns null", () => {
    const data = { anthropic: { access_token: "", expires_at_unix_ms: 123 } };
    expect(parseSculptorCredentials(data)).toBeNull();
  });

  test("missing expires_at_unix_ms defaults to 0", () => {
    const data = { anthropic: { access_token: "token-xyz" } };
    const result = parseSculptorCredentials(data);
    expect(result).toEqual({ access_token: "token-xyz", expires_at_unix_ms: 0 });
  });
});

// ── corsHeaders ───────────────────────────────────────────────────────────

describe("corsHeaders", () => {
  test("returns correct Access-Control-Allow-Origin with given origin", () => {
    const headers = corsHeaders("https://example.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://example.com");
  });

  test("returns correct Allow-Methods", () => {
    const headers = corsHeaders("http://localhost");
    expect(headers["Access-Control-Allow-Methods"]).toBe("POST, GET, OPTIONS");
  });

  test("returns correct Allow-Headers", () => {
    const headers = corsHeaders("http://localhost");
    expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization, X-Authorization");
  });

  test("returns correct Expose-Headers", () => {
    const headers = corsHeaders("http://localhost");
    expect(headers["Access-Control-Expose-Headers"]).toBe("X-Session-Id");
  });

  test("different origins produce different Allow-Origin values", () => {
    const a = corsHeaders("https://a.com");
    const b = corsHeaders("https://b.com");
    expect(a["Access-Control-Allow-Origin"]).not.toBe(b["Access-Control-Allow-Origin"]);
  });
});

// ── parseMarkersFromContent ───────────────────────────────────────────────

describe("parseMarkersFromContent", () => {
  let events: any[];
  const mockAppend = (partial: any) => {
    const event = { ...partial, id: events.length, ts: Date.now() };
    events.push(event);
    return event;
  };

  beforeEach(() => {
    events = [];
  });

  test("[AGENT_REGISTERED] with valid JSON calls appendFn with agent_registered event", () => {
    const content = [{
      type: "text",
      text: `[AGENT_REGISTERED] {"name":"Lyra","color":"#c9b1e8","colorName":"Violet Heaven","gender":"woman","gridPosition":0,"faceVariant":{"eyes":"standard","mouth":"gentle"}}`,
    }];
    parseMarkersFromContent(content, mockAppend, "session-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_registered");
    expect(events[0].agent.name).toBe("Lyra");
    expect(events[0].agent.gridPosition).toBe(0);
    expect(events[0].sessionId).toBe("session-1");
  });

  test("[AGENT_REGISTERED] with malformed JSON does not crash, appendFn NOT called", () => {
    const content = [{
      type: "text",
      text: `[AGENT_REGISTERED] {invalid json here`,
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("[AGENT_REGISTERED] missing gridPosition does not call appendFn", () => {
    const content = [{
      type: "text",
      text: `[AGENT_REGISTERED] {"name":"Lyra","color":"#c9b1e8"}`,
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("[AGENT_REGISTERED] missing name does not call appendFn", () => {
    const content = [{
      type: "text",
      text: `[AGENT_REGISTERED] {"gridPosition":0,"color":"#c9b1e8"}`,
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("[AGENT_STATUS] with agents array calls appendFn with agent_status", () => {
    const content = [{
      type: "text",
      text: `[AGENT_STATUS] {"agents":[{"name":"Lyra","status":"alive","gridPosition":0}]}`,
    }];
    parseMarkersFromContent(content, mockAppend, "s1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent_status");
    expect(events[0].agents).toHaveLength(1);
  });

  test("[AGENT_STATUS] with malformed JSON does not crash", () => {
    const content = [{
      type: "text",
      text: `[AGENT_STATUS] not-json`,
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("tool_use Write to memory/foo.html triggers artifact_written event", () => {
    const content = [{
      type: "tool_use",
      name: "Write",
      input: {
        file_path: "/opt/julian/memory/foo.html",
        content: "<html>hello</html>",
      },
    }];
    parseMarkersFromContent(content, mockAppend, "s1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("artifact_written");
    expect(events[0].filename).toBe("foo.html");
    expect(events[0].sizeBytes).toBe(18);
  });

  test("tool_use Write to non-memory path produces no event", () => {
    const content = [{
      type: "tool_use",
      name: "Write",
      input: {
        file_path: "/opt/julian/server/test.ts",
        content: "code",
      },
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("tool_use Write to memory/ but not .html produces no event", () => {
    const content = [{
      type: "tool_use",
      name: "Write",
      input: {
        file_path: "/opt/julian/memory/notes.md",
        content: "text",
      },
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("tool_use Bash with localhost:3848/cmd and FACE talking triggers screen_command", () => {
    const content = [{
      type: "tool_use",
      name: "Bash",
      input: {
        command: "curl -s -X POST localhost:3848/cmd -d 'FACE talking'",
      },
    }];
    parseMarkersFromContent(content, mockAppend, "s1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("screen_command");
    expect(events[0].expression).toBe("talking");
  });

  test("tool_use Bash with non-screen command produces no event", () => {
    const content = [{
      type: "tool_use",
      name: "Bash",
      input: {
        command: "git status",
      },
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("mixed content blocks extracts all markers", () => {
    const content = [
      {
        type: "text",
        text: `Some text\n[AGENT_REGISTERED] {"name":"A","gridPosition":0}\nmore text`,
      },
      {
        type: "tool_use",
        name: "Write",
        input: { file_path: "/memory/art.html", content: "hi" },
      },
      {
        type: "tool_use",
        name: "Bash",
        input: { command: "curl -s -X POST localhost:3848/cmd -d 'FACE happy'" },
      },
      {
        type: "text",
        text: `[AGENT_STATUS] {"agents":[{"name":"B","status":"alive","gridPosition":1}]}`,
      },
    ];
    parseMarkersFromContent(content, mockAppend, "s1");
    expect(events).toHaveLength(4);
    expect(events.map(e => e.type)).toEqual([
      "agent_registered",
      "artifact_written",
      "screen_command",
      "agent_status",
    ]);
  });

  test("empty content array does not crash", () => {
    parseMarkersFromContent([], mockAppend, null);
    expect(events).toHaveLength(0);
  });

  test("defaults gender to 'man' when not provided", () => {
    const content = [{
      type: "text",
      text: `[AGENT_REGISTERED] {"name":"Test","gridPosition":5}`,
    }];
    parseMarkersFromContent(content, mockAppend, null);
    expect(events[0].agent.gender).toBe("man");
  });
});

// ── createEventLog ────────────────────────────────────────────────────────

describe("createEventLog", () => {
  test("append auto-increments id starting from 0", () => {
    const log = createEventLog(100);
    const e0 = log.append({ sessionId: null, type: "test" });
    const e1 = log.append({ sessionId: null, type: "test" });
    const e2 = log.append({ sessionId: null, type: "test" });
    expect(e0.id).toBe(0);
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
  });

  test("append sets ts to current time", () => {
    const log = createEventLog(100);
    const before = Date.now();
    const event = log.append({ sessionId: null, type: "test" });
    const after = Date.now();
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after);
  });

  test("ring buffer caps at maxEvents, oldest evicted", () => {
    const log = createEventLog(3);
    log.append({ sessionId: null, type: "a" });
    log.append({ sessionId: null, type: "b" });
    log.append({ sessionId: null, type: "c" });
    log.append({ sessionId: null, type: "d" }); // evicts "a"
    const all = log.eventsAfter(-1);
    expect(all).toHaveLength(3);
    expect(all[0].type).toBe("b");
    expect(all[2].type).toBe("d");
  });

  test("eventsAfter(-1) returns all events", () => {
    const log = createEventLog(100);
    log.append({ sessionId: null, type: "x" });
    log.append({ sessionId: null, type: "y" });
    const all = log.eventsAfter(-1);
    expect(all).toHaveLength(2);
  });

  test("eventsAfter(N) returns only events with id > N", () => {
    const log = createEventLog(100);
    log.append({ sessionId: null, type: "a" }); // id 0
    log.append({ sessionId: null, type: "b" }); // id 1
    log.append({ sessionId: null, type: "c" }); // id 2
    const after1 = log.eventsAfter(1);
    expect(after1).toHaveLength(1);
    expect(after1[0].type).toBe("c");
  });

  test("subscriber notified on append", () => {
    const log = createEventLog(100);
    const received: ServerEvent[] = [];
    log.subscribe((e) => received.push(e));
    log.append({ sessionId: null, type: "notify-test" });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("notify-test");
  });

  test("subscriber errors do not propagate", () => {
    const log = createEventLog(100);
    log.subscribe(() => { throw new Error("boom"); });
    // Should not throw
    const event = log.append({ sessionId: null, type: "safe" });
    expect(event.type).toBe("safe");
  });

  test("multiple subscribers all notified", () => {
    const log = createEventLog(100);
    const received1: ServerEvent[] = [];
    const received2: ServerEvent[] = [];
    log.subscribe((e) => received1.push(e));
    log.subscribe((e) => received2.push(e));
    log.append({ sessionId: null, type: "multi" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
  });

  test("unsubscribe stops notifications", () => {
    const log = createEventLog(100);
    const received: ServerEvent[] = [];
    const fn = (e: ServerEvent) => received.push(e);
    log.subscribe(fn);
    log.append({ sessionId: null, type: "before" });
    expect(received).toHaveLength(1);
    log.unsubscribe(fn);
    log.append({ sessionId: null, type: "after" });
    expect(received).toHaveLength(1); // still 1, not 2
  });

  test("eventsAfter returns empty array when no events exist", () => {
    const log = createEventLog(100);
    expect(log.eventsAfter(-1)).toEqual([]);
    expect(log.eventsAfter(0)).toEqual([]);
  });

  test("append preserves extra fields from partial", () => {
    const log = createEventLog(100);
    const event = log.append({ sessionId: "s1", type: "custom", extra: "data", count: 42 });
    expect(event.sessionId).toBe("s1");
    expect(event.extra).toBe("data");
    expect(event.count).toBe(42);
  });
});
