#!/usr/bin/env bun
// scripts/mail-glance.ts — the mechanical pulse (docs/mail-heartbeat.md).
// Counts, senders, eligibility. No content is read here and no LLM runs
// here; a fully-waked session handles anything eligible. Bun auto-loads
// the repo .env, which is this process's sanctioned key scope (rule 5).

import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import {
  activeHoldIds, classifyThreads, knownFromSent, hasTrustworthyTimestamps,
  idsUsable, isSafeId, latestArrival, mergeHolds, normalizeThread, parseStateFile,
  type HeartbeatState, type Hold, type MailMessage, type MailThread,
} from './lib/mail-glance-lib';

const INBOX = 'julian-marcus@agentmail.to';
const API = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(INBOX)}`;
const KEY = process.env.AGENTMAIL_API_KEY;
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = join(homedir(), '.julian');
const STATE_PATH = join(STATE_DIR, 'mail-heartbeat.json');

// The state shape, the fetch-boundary normalizer, and every guard below
// them belong to the library, and so are unit-tested there. What is left
// here is I/O, ordering, and the decision to stay quiet — nothing this
// file decides about a thread is invented in this file.
type State = HeartbeatState;

function notify(text: string) {
  if (DRY) { console.log('[dry] notify:', text); return; }
  Bun.spawnSync(['osascript', '-e', `display notification ${JSON.stringify(text)} with title "Julian Mail"`]);
}

// Cap-hold expiry is the ONLY thing in this program that can make a
// previously-ineligible thread eligible, so it may never happen quietly —
// but it is detected in two places (before classifying, and again on the
// union at save time), and announcing it twice for one release is noise.
// This set lives for exactly one beat: announced once, never again, never
// zero. Loud beats silent.
const announcedExpiries = new Set<string>();

function announceExpiries(expired: Hold[]): void {
  const fresh = expired.map((h) => h.id).filter((id) => !announcedExpiries.has(id));
  if (!fresh.length) return;
  for (const id of fresh) announcedExpiries.add(id);
  notify(`cap-hold(s) expired and released: ${fresh.join(', ')} — threads eligible again`);
}

// Every failure path ends here: silence plus a notification, never a
// half-run beat and never an improvised send.
function abort(text: string, code = 1): never {
  console.error(`[glance] ${text}`);
  notify(`mail heartbeat: ${text}`);
  process.exit(code);
}

function usage(): never {
  console.error('usage: mail-glance.ts                         run one beat');
  console.error('       mail-glance.ts --hold <messageId>      park a thread (suspicion — stays until released by hand)');
  console.error('       mail-glance.ts --hold-cap <messageId>  park a thread for today\'s reply cap (auto-releases next UTC day)');
  // Routed through abort() like every other failure: no stop path in this
  // file is silent, so a mistyped invocation still reaches Marcus.
  abort('unrecognized arguments — no beat run, nothing sent', 2);
}

// The UTC calendar day a cap-hold is stamped with, and the day expiry is
// measured against. UTC, not local: the reply cap in the amended rule 6 is
// counted per UTC day, so the hold that enforces it must end on the same
// boundary the count resets on.
function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function freshState(): State {
  return { strangerWatermarkMs: 0, holds: [], updatedAt: '' };
}

// Thrown by loadStateFrom whenever a state file exists but cannot be trusted
// (unreadable, unparseable, wrong shape). Reading a corrupt file as empty
// would silently discard the held list, making a deliberately parked thread
// eligible again — an unintended send — so corruption is a distinct, typed
// failure rather than a fallback to fresh state.
export class StateCorruptError extends Error {}

// The injectable-path core: no DRY handling, no abort() — a caller (a test,
// or the STATE_PATH-bound wrapper below) decides what a failure means. A
// missing file is a first run and reads as fresh state; anything else that
// keeps the file from being read as valid state throws StateCorruptError.
export function loadStateFrom(path: string): HeartbeatState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return freshState();
    throw new StateCorruptError('state file unreadable');
  }

  const parsed = parseStateFile(raw);
  if (!parsed.ok) {
    throw new StateCorruptError(`state file corrupt (${parsed.reason})`);
  }
  return parsed.state;
}

// A missing file is a first run. Anything else — unreadable, unparseable,
// wrong shape — is corrupt, and reading a corrupt file as empty would
// silently discard the held list, making a deliberately parked thread
// eligible again. That is an unintended send, so corruption stops the beat.
// This is a thin wrapper: it binds loadStateFrom to STATE_PATH and translates
// StateCorruptError into the existing abort() call, byte-identical message.
function loadState(): State {
  try {
    return loadStateFrom(STATE_PATH);
  } catch (e) {
    if (e instanceof StateCorruptError) {
      abort(`${e.message} at ${STATE_PATH} — beat aborted, nothing sent`);
    }
    throw e;
  }
}

// The injectable-path core of writeState: write through a temp file and
// rename at the given path. Rename is atomic within the directory, so an
// interrupted beat can never leave a half-written file behind. A torn write
// would read as corrupt, and corruption halts every future beat — the
// heartbeat must not be able to stop its own heart.
export function writeStateTo(path: string, s: HeartbeatState): void {
  mkdirSync(dirname(path), { recursive: true });
  // Pid-unique temp name: a single shared `.tmp` path let two concurrent
  // writers (a beat and a reply session's `--hold`) interleave their writes
  // into the same scratch file and rename the wreckage into place.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, path);
}

// Thin wrapper bound to STATE_PATH: DRY gating stays here, not in the
// injectable core, so a test calling writeStateTo directly always performs a
// real write regardless of DRY_RUN.
function writeState(s: State) {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return; }
  writeStateTo(STATE_PATH, s);
}

// The injectable-path core of saveBeatState: re-read the file at `path`
// immediately before writing and union the on-disk holds with ours. A reply
// session from an earlier beat may have run `--hold` while this beat was in
// flight; dropping that parked id would make the thread eligible again — an
// unintended send. The watermark only ever moves forward, so take the later
// of the two.
//
// Expiry is executed HERE, on the union, because this is the last place a
// stale cap-hold could come back: the beat may have pruned it from its own
// copy, but it is still sitting on disk. The expired holds are returned
// rather than announced, so the caller can guarantee exactly one
// notification per beat for a release — silence is never an option, but two
// notifications for one release is noise.
export function saveBeatStateTo(
  path: string, s: HeartbeatState, todayUtcDay: string = utcDay(),
): { expired: Hold[] } {
  const onDisk = loadStateFrom(path);
  const merged = mergeHolds(onDisk.holds, s.holds);
  const { expired } = activeHoldIds(merged, todayUtcDay);
  const gone = new Set(expired);
  writeStateTo(path, {
    ...s,
    strangerWatermarkMs: Math.max(onDisk.strangerWatermarkMs, s.strangerWatermarkMs),
    holds: merged.filter((h) => !gone.has(h)),
  });
  return { expired };
}

// Thin wrapper bound to STATE_PATH: DRY gating plus the same
// StateCorruptError → abort() translation as loadState, so a corrupt on-disk
// file re-read during a beat-side save produces the exact same message it
// always has.
function saveBeatState(s: State): { expired: Hold[] } {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return { expired: [] }; }
  try {
    const r = saveBeatStateTo(STATE_PATH, s);
    // A stale cap-hold can still surface here — the union re-reads a disk
    // copy this beat never saw, and a beat that spans UTC midnight expires
    // holds it found active minutes earlier. Either way it is a release, so
    // it is announced (deduped against the pre-classify announcement).
    announceExpiries(r.expired);
    return r;
  } catch (e) {
    if (e instanceof StateCorruptError) {
      abort(`${e.message} at ${STATE_PATH} — beat aborted, nothing sent`);
    }
    throw e;
  }
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

// Read a thread id off a raw listing entry without trusting the dialect or
// the type. AgentMail speaks snake_case (`thread_id`); the library speaks
// camelCase. Anything that is not a safe id yields undefined, and an
// undefined id is never turned into a request path.
function listedThreadId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const id = r.threadId ?? r.thread_id;
  return typeof id === 'string' && isSafeId(id) ? id : undefined;
}

// The sent listing is a list of messages, not a thread, and the library's
// normalize boundary is thread-shaped and all-or-nothing by design (a
// thread carrying one malformed message is not a trustworthy thread). Here
// the opposite is right: one odd sent message must not erase every known
// correspondent and turn the whole address book into strangers. So each raw
// message goes through that same library boundary on its own and the bad
// ones drop out — no second normalizer, one dialect translated in one
// tested place.
function normalizeSentMessages(raw: unknown[]): MailMessage[] {
  const out: MailMessage[] = [];
  for (const m of raw) {
    const r = normalizeThread({ threadId: 'sent-listing', messages: [m] });
    if (r.ok && r.thread.messages.length === 1) out.push(r.thread.messages[0]);
  }
  return out;
}

async function main() {
  // Strict argv, before any state read or network call: a typo like
  // `--dry-run` must print usage, never fall through into a live beat.
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    const flag = argv[0];
    if ((flag !== '--hold' && flag !== '--hold-cap') || argv.length !== 2 || !argv[1]) usage();
    const id = argv[1];
    // `--hold` is the unchanged, unqualified park: a reason nobody wrote down
    // is a reason no clock may overrule, so it is suspicion and it stays.
    // `--hold-cap` is the one hold that says what it is — "capped for today" —
    // and so is the one hold allowed to end by itself.
    const hold: Hold = flag === '--hold-cap'
      ? { id, kind: 'cap', heldUtcDay: utcDay() }
      : { id, kind: 'suspicion', heldUtcDay: '' };
    const s = loadState();
    // mergeHolds is the dedupe: one entry per id, and on a conflict the
    // longer-lasting hold survives (so --hold-cap can never downgrade a
    // suspicion hold that is already parked on this id).
    s.holds = mergeHolds(s.holds, [hold]);
    writeState(s);
    console.log(`[glance] held ${id} (${hold.kind})`);
    return;
  }

  if (!KEY) abort('no AGENTMAIL_API_KEY in env; aborting', 2);

  // Fail fast on a corrupt state file before spending any network calls;
  // the value actually used for classification is re-read below.
  loadState();

  const sentRes = await get('/messages?limit=100') as { messages?: unknown[] };
  const sent = normalizeSentMessages(sentRes.messages ?? [])
    .filter((m) => m.labels?.includes('sent'));
  const known = knownFromSent(sent);

  const listRes = await get('/threads?limit=50') as { threads?: unknown[] };
  const listed = listRes.threads ?? [];
  const threads: MailThread[] = [];
  let unfetchable = 0;
  const unreadable: string[] = [];
  for (const raw of listed) {
    const id = listedThreadId(raw);
    // Never build a request path out of an id we have not verified.
    if (id === undefined) { unfetchable++; continue; }
    const normalized = normalizeThread(await get(`/threads/${encodeURIComponent(id)}`));
    // One malformed message costs one thread, never the heartbeat: the
    // thread drops out with its reason surfaced and the beat carries on for
    // every thread that did parse.
    if (!normalized.ok) { unreadable.push(normalized.reason); continue; }
    threads.push(normalized.thread);
  }
  if (unfetchable) {
    notify(`${unfetchable} thread(s) not fetched — missing or unexpected thread ids in the listing`);
  }
  if (unreadable.length) {
    // One notification carrying the distinct reasons rather than one per
    // thread: when a wire-format change breaks every thread at once, fifty
    // identical alerts bury the signal instead of raising it.
    notify(`${unreadable.length} thread(s) skipped — ${[...new Set(unreadable)].join('; ')}`);
  }

  // The deaf beat: a listing that arrived but produced nothing readable.
  // Without this check a renamed container key drops every thread at the
  // boundary and the beat prints a cheerful "nothing eligible" forever —
  // the last failure mode that could still go quiet. Loud beats silent.
  if (listed.length > 0 && threads.every((t) => t.messages.length === 0)) {
    notify(`mail heartbeat may be deaf: ${listed.length} threads listed, 0 readable`);
  }

  // Re-read the state immediately before classifying: a reply session from
  // an earlier beat may have run `--hold` while this beat was mid-fetch, and
  // a thread parked in that window must be honored by THIS classification,
  // not only by the union at save time.
  const state = loadState();

  // The one change in this program that can make a previously-ineligible
  // thread eligible, and it announces itself. A cap-hold says "capped for
  // this UTC day"; once that day is over the statement is simply no longer
  // true, and leaving it in place was the bug (#18) — a thread parked for
  // one day's cap stayed parked forever. Suspicion-holds are untouched.
  const { active, expired } = activeHoldIds(state.holds, utcDay());
  if (expired.length) {
    announceExpiries(expired);
    // Persist the release now, in the same beat that announced it, so the
    // announcement is made exactly once. saveBeatStateTo re-prunes the union
    // with the on-disk copy, so the expired holds cannot come back.
    const gone = new Set(expired);
    state.holds = state.holds.filter((h) => !gone.has(h));
    saveBeatState(state);
  }

  const { eligible, strangers } = classifyThreads(threads, known, INBOX, active);

  // Strangers: notify once per new arrival (watermark), content unread.
  // `latestArrival` also reports whether the time it returned came from the
  // mail or from the now-fallback it uses when a thread's clock is garbled.
  const now = Date.now();
  const strangerArrivals = strangers.map((t) => latestArrival(t, now));
  const fresh = strangerArrivals.filter((a) => a.ms > state.strangerWatermarkMs);
  if (fresh.length) {
    notify(`${fresh.length} new thread(s) from unknown senders — quarantined, unread`);
    // Only genuine, in-the-past timestamps may advance the watermark.
    // Clamping to now stops a message stamped 2099 from pushing the mark
    // past every real arrival and silencing stranger notifications forever;
    // dropping the untrusted ones stops a thread whose clock is garbled —
    // whose `ms` was fabricated as now — from doing the same to a genuine
    // stranger message that shows up in the listing a beat later. Garbled
    // threads keep notifying every beat; they just never move the mark.
    const advancing = fresh.filter((a) => a.trusted).map((a) => Math.min(a.ms, now));
    if (advancing.length) {
      state.strangerWatermarkMs = Math.max(state.strangerWatermarkMs, ...advancing);
      saveBeatState(state);
    }
  }

  // threadIds and messageIds are remote-controlled, and the thread ids are
  // the only such strings that reach the spawned session's instructions.
  // Reject rather than escape: a thread carrying an odd id is left for Marcus.
  const safe = eligible.filter((t) => idsUsable(t));
  const skipped = eligible.length - safe.length;
  if (skipped) {
    notify(`${skipped} eligible thread(s) skipped — missing or unexpected characters in remote ids`);
  }

  // A thread whose clock cannot be read cannot be ordered, and a thread that
  // cannot be ordered cannot be shown to be unanswered. Never auto-reply into
  // that: skip toward silence plus a notification and let Marcus look.
  const dated = safe.filter((t) => hasTrustworthyTimestamps(t));
  const undated = safe.length - dated.length;
  if (undated) {
    notify(`${undated} eligible thread(s) skipped — unreadable message timestamps`);
  }

  if (!dated.length) { console.log(`[glance] ${new Date().toISOString()} nothing eligible`); return; }

  const ids = dated.map((t) => t.threadId);
  console.log(`[glance] eligible: ${ids.join(', ')}`);
  if (DRY) { console.log('[dry] would spawn reply session for the threads above'); return; }

  const promptPath = join(import.meta.dir, 'lib', 'mail-reply-prompt.md');
  if (!existsSync(promptPath)) {
    // Fail toward silence: no template, no improvised prompt, no send.
    abort('reply prompt template missing — no session spawned');
  }
  const template = readFileSync(promptPath, 'utf8');
  const prompt = template.replace('{{THREAD_IDS}}', ids.join(', '));

  // The child sources .env per-command (rule 5); the key never becomes
  // ambient state in the reply session's environment.
  const childEnv = { ...process.env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' };
  delete childEnv.AGENTMAIL_API_KEY;

  // Deliberately attached — no unref(). The runner stays alive for as long as
  // the reply session it spawned, so launchd's per-label serialization of
  // com.julian.mail-heartbeat keeps the next beat from starting on top of a
  // session that is still drafting.
  Bun.spawn(
    ['claude', '-p', prompt, '--permission-mode', 'acceptEdits',
     '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep'],
    {
      cwd: process.cwd(),
      stdout: 'inherit', stderr: 'inherit',
      env: childEnv,
    },
  );
}

// Main-guard: importing this module (e.g. from a test) must run no beat —
// no network call, no exit, no spawned session. Only running it directly
// (`bun scripts/mail-glance.ts`, the launchd entry point) executes main().
if (import.meta.main) {
  main().catch((e) => {
    // Logged by launchd and surfaced to Marcus; the next beat retries.
    abort(`failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}
