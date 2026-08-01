// Pure eligibility logic for the mail heartbeat (docs/mail-heartbeat.md).
// No I/O here — everything testable with synthetic fixtures.

export interface MailMessage {
  messageId: string;
  from: string;                     // may be "Name <addr>" form
  to?: string[];
  subject?: string;
  timestamp: string;                // ISO 8601
  labels?: string[];
  headers?: Record<string, string>;
}

export interface MailThread {
  threadId: string;
  subject?: string;
  messages: MailMessage[];          // chronological, oldest first
}

export function extractAddress(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

export function knownFromSent(sent: MailMessage[]): Set<string> {
  const known = new Set<string>();
  for (const m of sent) for (const r of m.to ?? []) known.add(extractAddress(r));
  return known;
}

const NOREPLY_LOCALS = new Set(['no-reply', 'noreply', 'donotreply', 'do-not-reply']);

export function isAutomated(msg: MailMessage): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers ?? {})) h[k.toLowerCase()] = String(v).toLowerCase();
  if (h['auto-submitted'] && h['auto-submitted'] !== 'no') return true;
  if (h['precedence'] === 'bulk' || h['precedence'] === 'list') return true;
  return NOREPLY_LOCALS.has(extractAddress(msg.from).split('@')[0]);
}

export interface GlanceResult { eligible: MailThread[]; strangers: MailThread[] }

// Parse a timestamp for comparison. Returns null when missing/unparseable —
// callers must not silently coerce that into a sortable number, because
// mixing a bad timestamp into an otherwise-good comparison is exactly the
// double-send edge this function exists to avoid.
function parseTime(ts: string | undefined): number | null {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? null : t;
}

// The message with the greatest timestamp, falling back to the last array
// element on ties OR when ANY message in the thread has a missing/
// unparseable timestamp. Threads are contracted to arrive chronological
// (oldest first), but the API is not trusted to honor that — picking by
// position alone would let an already-answered thread (my reply arrived
// first in a misordered array) classify as eligible and reply twice.
// Whole-thread fallback (not per-message): a single bad timestamp on my
// own outbound reply must not let it lose a timestamp race it never
// entered — that's the same double-send edge, just mixed instead of
// reordered. When any timestamp in the thread can't be trusted, none of
// them are; the plan's original last-element semantics take over.
function pickLatest(messages: MailMessage[]): MailMessage | undefined {
  if (messages.length === 0) return undefined;
  const times = messages.map((m) => parseTime(m.timestamp));
  if (times.some((t) => t === null)) return messages[messages.length - 1];
  let best = messages[0];
  let bestTime = times[0] as number;
  for (let i = 1; i < messages.length; i++) {
    const t = times[i] as number;
    if (t >= bestTime) { best = messages[i]; bestTime = t; }
  }
  return best;
}

// A thread is eligible while its latest message is inbound, known, not
// automated, and not explicitly held. No watermark here: unanswered mail
// self-heals every beat; once I reply, I am the latest and it drops out.
export function classifyThreads(
  threads: MailThread[], known: Set<string>, selfAddr: string, held: Set<string>,
): GlanceResult {
  const self = selfAddr.toLowerCase();
  const eligible: MailThread[] = [];
  const strangers: MailThread[] = [];
  for (const t of threads) {
    const latest = pickLatest(t.messages);
    if (!latest) continue;
    if (extractAddress(latest.from) === self) continue;
    if (held.has(latest.messageId)) continue;
    if (isAutomated(latest)) continue;
    (known.has(extractAddress(latest.from)) ? eligible : strangers).push(t);
  }
  return { eligible, strangers };
}

// Safety guards for the runner (scripts/mail-glance.ts). threadId and
// messageId are the only remote-controlled strings that reach the spawned
// reply session's instructions — they must be restricted before
// interpolation into that prompt.
export const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

export function isSafeId(s: string): boolean {
  return SAFE_ID.test(s);
}

export function hasSafeIds(t: MailThread): boolean {
  if (!isSafeId(t.threadId)) return false;
  return t.messages.every((m) => isSafeId(m.messageId));
}

export interface HeartbeatState {
  strangerWatermarkMs: number;
  held: string[];
  updatedAt: string;
}

export type ParsedStateFile =
  | { ok: true; state: HeartbeatState }
  | { ok: false; reason: string };

// Strict shape validation for ~/.julian/mail-heartbeat.json. A corrupt file
// must be distinguishable from a missing one: silently discarding a bad
// file's held list would un-park a deliberately parked thread and reply to
// it again — an unintended send.
export function parseStateFile(raw: string): ParsedStateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.held) || !obj.held.every((h) => typeof h === 'string')) {
    return { ok: false, reason: 'held is not an array of strings' };
  }
  if (typeof obj.strangerWatermarkMs !== 'number' || !Number.isFinite(obj.strangerWatermarkMs)) {
    return { ok: false, reason: 'strangerWatermarkMs is not a finite number' };
  }
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';
  return {
    ok: true,
    state: { strangerWatermarkMs: obj.strangerWatermarkMs, held: obj.held as string[], updatedAt },
  };
}
