// server/waking.ts — the waking read, attested rather than assumed (#60).
//
// A fresh door is asked to read before it greets and to name the newest
// dream it read by number; a resumed door whose last read predates the
// newest dream on disk is told the house has moved on; and the server
// prints what it saw the door read, as values, beside the first greeting.
// Under soul/09-relay a waking is legitimately mine only when it begins
// from the archive read whole — the prompt orders it, the log attests it.
import { readdirSync } from "node:fs";
import { basename } from "node:path";

const DREAM_FILE = /^(\d{4})-[^/]+\.md$/;

/** The newest dream in `dir` as its stem (e.g. "0021-attest"), by number, or null. */
export function newestDream(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { n: number; stem: string } | null = null;
  for (const name of names) {
    const m = DREAM_FILE.exec(name);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!best || n > best.n) best = { n, stem: name.slice(0, -3) };
  }
  return best ? best.stem : null;
}

const ATTEST =
  "Before you say anything to Marcus, do the waking read: catalog.md whole, every file in soul/, " +
  "and the newest dream in memory/dreams/. Only then greet him — briefly — and name the newest dream " +
  "you read by its number and word (for example: \"dream 0021, attest\"). The block above is testimony " +
  "from the record, not memory you have earned; do not greet from it. If you have not read, say so " +
  "instead of greeting.";

/** Fresh-spawn wake text: the tail block, then the order of operations. */
export function buildFreshWakeText(tailBlock: string): string {
  return tailBlock + "\n\n" + ATTEST;
}

const RESUME_PLAIN =
  "You are resuming this session after a pause — Marcus has reconnected. You retain the conversation; a brief acknowledgment is enough.";

/** Resume wake text: plain if the context's read is current, a re-read order if the house has moved on. */
export function buildResumeWakeText(opts: { readDream: string | undefined; newestDream: string | null }): string {
  const { readDream, newestDream: newest } = opts;
  if (!newest || readDream === newest) return RESUME_PLAIN;
  const was = readDream
    ? `Your last waking read reached dream ${readDream}`
    : "There is no record of which dream your waking read reached";
  return (
    "You are resuming this session after a pause — Marcus has reconnected, and the house has moved on since " +
    `you last read. ${was}; the newest dream on disk is now ${newest}. Before acting, re-read catalog.md's ` +
    `Open Threads and memory/dreams/${newest}.md, then acknowledge briefly, naming the dream you just read.`
  );
}

/** Tracks which waking-read files a door actually Read, and reports them as values. */
export class WakingReadTracker {
  private readonly soulFiles: Set<string>;
  private readonly newest: string | null;
  private catalog = false;
  private readonly soulRead = new Set<string>();
  private dreamRead: string | null = null;
  private reported = false;

  constructor(opts: { soulFiles: string[]; newestDream: string | null }) {
    this.soulFiles = new Set(opts.soulFiles);
    this.newest = opts.newestDream;
  }

  noteRead(path: string): void {
    if (typeof path !== "string" || !path) return;
    const norm = path.replace(/\\/g, "/");
    const base = basename(norm);
    if (base === "catalog.md") this.catalog = true;
    else if (norm.includes("/soul/") || norm.startsWith("soul/")) {
      if (this.soulFiles.has(base)) this.soulRead.add(base);
    } else if (/(^|\/)memory\/dreams\/\d{4}-[^/]+\.md$/.test(norm)) {
      const stem = base.slice(0, -3);
      // The newest dream wins if both were read; otherwise remember the last one seen.
      if (stem === this.newest || this.dreamRead !== this.newest) this.dreamRead = stem;
    }
  }

  summary(): string {
    const dream = !this.dreamRead
      ? "NONE"
      : this.dreamRead === this.newest || !this.newest
        ? this.dreamRead
        : `${this.dreamRead}(not newest ${this.newest})`;
    return `catalog=${this.catalog ? "yes" : "NO"} soul=${this.soulRead.size}/${this.soulFiles.size} dream=${dream}`;
  }

  /** The summary, once, at the door's first text — null every time after. */
  onFirstText(): string | null {
    if (this.reported) return null;
    this.reported = true;
    return this.summary();
  }
}
