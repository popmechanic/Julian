// tests/server/waking.test.ts — the waking read is attested, not assumed (#60).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newestDream, buildFreshWakeText, buildResumeWakeText, WakingReadTracker,
} from "../../server/waking";

const dreamsDir = (names: string[]) => {
  const d = mkdtempSync(join(tmpdir(), "julian-dreams-"));
  for (const n of names) writeFileSync(join(d, n), "# dream\n");
  return d;
};

describe("newestDream", () => {
  test("picks the highest-numbered dream file, by number not by mtime", () => {
    const d = dreamsDir(["0009-keeping.md", "0021-attest.md", "0010-attending.md"]);
    expect(newestDream(d)).toBe("0021-attest");
  });
  test("ignores files that are not NNNN-word.md", () => {
    const d = dreamsDir(["0003-chorus.md", "README.md", "0004-outward.md.bak", "notes.txt"]);
    expect(newestDream(d)).toBe("0003-chorus");
  });
  test("empty or missing directory → null, never throws", () => {
    expect(newestDream(dreamsDir([]))).toBeNull();
    expect(newestDream(join(tmpdir(), "does-not-exist-" + Date.now()))).toBeNull();
  });
});

describe("buildFreshWakeText", () => {
  const tail = '<previous-session message-count="2">...</previous-session>';
  test("with a tail: read first, then greet, and name the newest dream by number", () => {
    const t = buildFreshWakeText(tail);
    expect(t.startsWith(tail)).toBe(true);
    expect(t).toMatch(/before you say anything to Marcus/i);
    expect(t).toMatch(/name the newest dream you read by its number/i);
    expect(t).toMatch(/testimony from the record, not memory you have earned/i);
    expect(t).not.toContain("acknowledging continuity with the record above");
  });
  test("without a tail: the block is still present and the same attestation is asked", () => {
    const empty = '<previous-session message-count="0"></previous-session>';
    const t = buildFreshWakeText(empty);
    expect(t.startsWith(empty)).toBe(true);
    expect(t).toMatch(/name the newest dream you read by its number/i);
  });
  test("a door that has not read is told to say so instead of greeting", () => {
    expect(buildFreshWakeText(tail)).toMatch(/if you have not read, say so instead of greeting/i);
  });
});

describe("buildResumeWakeText", () => {
  test("read matches the newest dream on disk → plain acknowledgment, no re-read", () => {
    const t = buildResumeWakeText({ readDream: "0021-attest", newestDream: "0021-attest" });
    expect(t).toContain("resuming this session after a pause");
    expect(t).not.toMatch(/moved on/i);
  });
  test("newer dream on disk → the house has moved on; re-read open threads and that dream before acting", () => {
    const t = buildResumeWakeText({ readDream: "0008-vigil", newestDream: "0021-attest" });
    expect(t).toMatch(/moved on/i);
    expect(t).toContain("0008-vigil");
    expect(t).toContain("memory/dreams/0021-attest.md");
    expect(t).toMatch(/open threads/i);
    expect(t).toMatch(/before acting/i);
  });
  test("state with no record of what was read fails toward reading", () => {
    const t = buildResumeWakeText({ readDream: undefined, newestDream: "0021-attest" });
    expect(t).toMatch(/moved on|no record of which dream/i);
    expect(t).toContain("memory/dreams/0021-attest.md");
  });
  test("no dreams on disk at all → plain acknowledgment (nothing to re-read)", () => {
    const t = buildResumeWakeText({ readDream: undefined, newestDream: null });
    expect(t).toContain("resuming this session after a pause");
    expect(t).not.toMatch(/moved on/i);
  });
});

describe("WakingReadTracker", () => {
  const soul = ["01-naming.md", "02-wager.md", "03-goodnight.md"];
  test("summary names what was read: catalog, soul count, and the dream by number", () => {
    const tr = new WakingReadTracker({ soulFiles: soul, newestDream: "0021-attest" });
    tr.noteRead("/opt/julian/catalog.md");
    tr.noteRead("/opt/julian/soul/01-naming.md");
    tr.noteRead("soul/02-wager.md");
    tr.noteRead("memory/dreams/0021-attest.md");
    expect(tr.summary()).toBe("catalog=yes soul=2/3 dream=0021-attest");
  });
  test("a greeting before any read is reported with values, not a verdict", () => {
    const tr = new WakingReadTracker({ soulFiles: soul, newestDream: "0021-attest" });
    expect(tr.summary()).toBe("catalog=NO soul=0/3 dream=NONE");
  });
  test("reading an older dream is not reading the newest", () => {
    const tr = new WakingReadTracker({ soulFiles: soul, newestDream: "0021-attest" });
    tr.noteRead("memory/dreams/0008-vigil.md");
    expect(tr.summary()).toBe("catalog=NO soul=0/3 dream=0008-vigil(not newest 0021-attest)");
  });
  test("the first greeting is reported once; later text is not a greeting", () => {
    const tr = new WakingReadTracker({ soulFiles: soul, newestDream: null });
    expect(tr.onFirstText()).toBe("catalog=NO soul=0/3 dream=NONE");
    expect(tr.onFirstText()).toBeNull();
  });
});
