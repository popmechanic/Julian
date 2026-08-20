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

// Safety guard for the runner (scripts/mail-glance.ts). threadId is the
// ONLY remote-controlled string that reaches the spawned reply session's
// prompt (the runner interpolates it directly), so it stays restricted to
// this alphabet. messageIds never reach that prompt — see idsUsable below,
// which checks them only for presence, not shape.
export const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

export function isSafeId(s: string): boolean {
  return typeof s === 'string' && SAFE_ID.test(s);
}

// Live AgentMail message ids are RFC 5322 Message-IDs (e.g.
// "<abc+123=x@mail.example.com>") and fail SAFE_ID's alphabet by design —
// that alphabet exists to protect the prompt, and messageIds never reach
// it. A thread is usable when its threadId is safe (it is a UUID in
// practice) and every messageId is a non-empty string — never a value
// that a cast could let through as `undefined`.
export function idsUsable(t: MailThread): boolean {
  if (!isSafeId(t.threadId)) return false;
  return t.messages.every((m) => typeof m.messageId === 'string' && m.messageId.length > 0);
}

// True only when every message in the thread has a parseable timestamp.
// The runner keeps threads with untrustworthy clocks out of autonomous
// replies entirely (fail toward silence + notification) — this closes the
// compound edge where a positional fallback on a newest-first listing
// could select the wrong message as "latest".
export function hasTrustworthyTimestamps(t: MailThread): boolean {
  return t.messages.every((m) => parseTime(m.timestamp) !== null);
}

// A parked thread, and WHY it is parked — the distinction #18 exists for.
// 'cap' means "this thread hit its daily reply cap", which is true only of
// the UTC day recorded in heldUtcDay; it releases itself when that day is
// over. 'suspicion' means "something about this felt wrong", which no clock
// can un-feel, so it is released only by hand. heldUtcDay is '' for
// suspicion holds (and for any cap hold whose day is unknown, which
// therefore never auto-releases).
export interface Hold {
  id: string;
  kind: 'cap' | 'suspicion';
  heldUtcDay: string;               // 'YYYY-MM-DD' (UTC), or '' for none
}

export interface HeartbeatState {
  strangerWatermarkMs: number;
  holds: Hold[];
  updatedAt: string;
}

export type ParsedStateFile =
  | { ok: true; state: HeartbeatState }
  | { ok: false; reason: string };

function parseHold(raw: unknown): Hold | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.id !== 'string' || h.id.length === 0) return null;
  if (h.kind !== 'cap' && h.kind !== 'suspicion') return null;
  if (typeof h.heldUtcDay !== 'string') return null;
  return { id: h.id, kind: h.kind, heldUtcDay: h.heldUtcDay };
}

// Strict shape validation for ~/.julian/mail-heartbeat.json. A corrupt file
// must be distinguishable from a missing one: silently discarding a bad
// file's holds would un-park a deliberately parked thread and reply to it
// again — an unintended send.
//
// Both shapes are accepted, because a state file written before #18 is on
// disk right now: legacy `held: string[]` migrates to suspicion holds. That
// is the safe direction — the old format recorded no reason, and a hold
// whose intent is unknown must never auto-release. A file carrying BOTH
// keys is corrupt: two disagreeing hold lists cannot be reconciled without
// a guess, and a wrong guess releases a parked thread.
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

  const hasHolds = Object.prototype.hasOwnProperty.call(obj, 'holds');
  const hasHeld = Object.prototype.hasOwnProperty.call(obj, 'held');
  if (hasHolds && hasHeld) {
    return { ok: false, reason: 'both holds and held are present — ambiguous hold list' };
  }
  let holds: Hold[];
  if (hasHolds) {
    if (!Array.isArray(obj.holds)) return { ok: false, reason: 'holds is not an array' };
    holds = [];
    for (const raw of obj.holds) {
      const h = parseHold(raw);
      if (h === null) return { ok: false, reason: 'holds contains an entry that is not {id, kind, heldUtcDay}' };
      holds.push(h);
    }
  } else if (hasHeld) {
    if (!Array.isArray(obj.held) || !obj.held.every((h) => typeof h === 'string')) {
      return { ok: false, reason: 'held is not an array of strings' };
    }
    holds = (obj.held as string[]).map((id) => ({ id, kind: 'suspicion' as const, heldUtcDay: '' }));
  } else {
    return { ok: false, reason: 'neither holds nor held is present' };
  }

  if (typeof obj.strangerWatermarkMs !== 'number' || !Number.isFinite(obj.strangerWatermarkMs)) {
    return { ok: false, reason: 'strangerWatermarkMs is not a finite number' };
  }
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : '';
  return { ok: true, state: { strangerWatermarkMs: obj.strangerWatermarkMs, holds, updatedAt } };
}

/** Cap-holds parked on an earlier UTC day expire (they were 'capped for today'); suspicion-holds never expire (#18). */
export function activeHoldIds(holds: Hold[], todayUtcDay: string): { active: Set<string>; expired: Hold[] } {
  const active = new Set<string>();
  const expired: Hold[] = [];
  for (const h of holds) {
    if (h.kind === 'cap' && h.heldUtcDay !== '' && h.heldUtcDay < todayUtcDay) expired.push(h);
    else active.add(h.id);
  }
  return { active, expired };
}

// Does `a` hold the thread for at least as long as `b` would?
// suspicion (never releases) > dayless cap (never releases) > later day > earlier day.
function outlasts(a: Hold, b: Hold): boolean {
  if (a.kind === 'suspicion') return true;
  if (b.kind === 'suspicion') return false;
  if (a.heldUtcDay === '') return true;
  if (b.heldUtcDay === '') return false;
  return a.heldUtcDay >= b.heldUtcDay;
}

// Union two hold lists, keyed by id. Every tie-break leans the same way —
// toward the hold that lasts longer — because this runs where a beat's view
// of the holds meets a concurrent `--hold`'s, and losing a park is the one
// outcome that sends mail.
export function mergeHolds(a: Hold[], b: Hold[]): Hold[] {
  const byId = new Map<string, Hold>();
  for (const h of [...a, ...b]) {
    const prev = byId.get(h.id);
    if (prev === undefined || !outlasts(prev, h)) byId.set(h.id, h);
  }
  return [...byId.values()];
}

// --- The normalize boundary: AgentMail's wire shape → our contract -------
//
// AgentMail returns snake_case (thread_id, message_id) at some endpoints
// and doesn't guarantee every field is present or well-typed. This is the
// one place that trust gets extended to the network: a missing `from` or
// `messageId` becomes ok:false with a reason, never a cast that lets
// `undefined` slip through to extractAddress or the prompt.

export type NormalizedThread =
  | { ok: true; thread: MailThread }
  | { ok: false; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeMessage(raw: unknown, index: number): { ok: true; message: MailMessage } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: `message ${index} is not an object` };
  const messageId = raw.messageId ?? raw.message_id;
  if (typeof messageId !== 'string' || messageId.length === 0) {
    return { ok: false, reason: `message ${index} is missing messageId` };
  }
  const from = raw.from;
  if (typeof from !== 'string' || from.length === 0) {
    return { ok: false, reason: `message ${index} is missing from` };
  }
  const timestamp = raw.timestamp;
  if (typeof timestamp !== 'string') {
    return { ok: false, reason: `message ${index} is missing timestamp` };
  }
  const message: MailMessage = { messageId, from, timestamp };
  if (Array.isArray(raw.to)) message.to = raw.to as string[];
  if (typeof raw.subject === 'string') message.subject = raw.subject;
  if (Array.isArray(raw.labels)) message.labels = raw.labels as string[];
  if (isPlainObject(raw.headers)) message.headers = raw.headers as Record<string, string>;
  return { ok: true, message };
}

// Maps AgentMail's raw thread shape (snake_case field names, untrusted
// types) into our MailThread contract. `messages` missing or under the
// wrong key is ok:false — distinguishable from a genuinely empty thread
// (`messages: []`, which is ok:true).
export function normalizeThread(raw: unknown): NormalizedThread {
  if (!isPlainObject(raw)) return { ok: false, reason: 'thread is not an object' };
  const threadId = raw.threadId ?? raw.thread_id;
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return { ok: false, reason: 'thread is missing threadId' };
  }
  const rawMessages = raw.messages;
  if (!Array.isArray(rawMessages)) {
    return { ok: false, reason: 'thread is missing a messages array' };
  }
  const messages: MailMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const r = normalizeMessage(rawMessages[i], i);
    if (!r.ok) return { ok: false, reason: r.reason };
    messages.push(r.message);
  }
  const thread: MailThread = { threadId, messages };
  if (typeof raw.subject === 'string') thread.subject = raw.subject;
  return { ok: true, thread };
}

// The most recent arrival time in a thread, for the stranger-notification
// watermark. `trusted: false` whenever ANY message's timestamp is missing
// or unparseable — in that case `ms` is the max of whatever DID parse and
// `nowMs`, so an unparseable timestamp can never be read as "never
// notified" (that would silence a genuine stranger message forever).
export function latestArrival(t: MailThread, nowMs: number): { ms: number; trusted: boolean } {
  let maxParsed: number | null = null;
  let anyUnparseable = false;
  for (const m of t.messages) {
    const parsed = parseTime(m.timestamp);
    if (parsed === null) {
      anyUnparseable = true;
    } else if (maxParsed === null || parsed > maxParsed) {
      maxParsed = parsed;
    }
  }
  if (anyUnparseable) {
    return { ms: Math.max(maxParsed ?? -Infinity, nowMs), trusted: false };
  }
  return { ms: maxParsed ?? nowMs, trusted: true };
}
