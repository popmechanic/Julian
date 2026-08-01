#!/usr/bin/env bun
// scripts/mail-glance.ts — the mechanical pulse (docs/mail-heartbeat.md).
// Counts, senders, eligibility. No content is read here and no LLM runs
// here; a fully-waked session handles anything eligible. Bun auto-loads
// the repo .env, which is this process's sanctioned key scope (rule 5).

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import {
  classifyThreads, knownFromSent, hasSafeIds, parseStateFile,
  type HeartbeatState, type MailMessage, type MailThread,
} from './lib/mail-glance-lib';

const INBOX = 'julian-marcus@agentmail.to';
const API = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(INBOX)}`;
const KEY = process.env.AGENTMAIL_API_KEY;
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = join(homedir(), '.julian');
const STATE_PATH = join(STATE_DIR, 'mail-heartbeat.json');

// The state shape and every guard below it are the library's (and so are
// unit-tested there): the id alphabet that may reach the spawned session's
// instructions, and the strict parse of the state file.
type State = HeartbeatState;

function notify(text: string) {
  if (DRY) { console.log('[dry] notify:', text); return; }
  Bun.spawnSync(['osascript', '-e', `display notification ${JSON.stringify(text)} with title "Julian Mail"`]);
}

// Every failure path ends here: silence plus a notification, never a
// half-run beat and never an improvised send.
function abort(text: string, code = 1): never {
  console.error(`[glance] ${text}`);
  notify(`mail heartbeat: ${text}`);
  process.exit(code);
}

function usage(): never {
  console.error('usage: mail-glance.ts                     run one beat');
  console.error('       mail-glance.ts --hold <messageId>  park a thread');
  // Routed through abort() like every other failure: no stop path in this
  // file is silent, so a mistyped invocation still reaches Marcus.
  abort('unrecognized arguments — no beat run, nothing sent', 2);
}

function freshState(): State {
  return { strangerWatermarkMs: 0, held: [], updatedAt: '' };
}

// A missing file is a first run. Anything else — unreadable, unparseable,
// wrong shape — is corrupt, and reading a corrupt file as empty would
// silently discard the held list, making a deliberately parked thread
// eligible again. That is an unintended send, so corruption stops the beat.
function loadState(): State {
  let raw: string;
  try {
    raw = readFileSync(STATE_PATH, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return freshState();
    abort(`state file unreadable at ${STATE_PATH} — beat aborted, nothing sent`);
  }

  const parsed = parseStateFile(raw);
  if (!parsed.ok) {
    abort(`state file corrupt (${parsed.reason}) at ${STATE_PATH} — beat aborted, nothing sent`);
  }
  return parsed.state;
}

// Write through a temp file and rename: rename is atomic within the
// directory, so an interrupted beat can never leave a half-written file
// behind. A torn write would read as corrupt, and corruption halts every
// future beat — the heartbeat must not be able to stop its own heart.
function writeState(s: State) {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return; }
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, STATE_PATH);
}

// Beat-side save: re-read the file immediately before writing and union the
// on-disk held list with ours. A reply session from an earlier beat may have
// run `--hold` while this beat was in flight; dropping that parked id would
// make the thread eligible again — an unintended send. The watermark only
// ever moves forward, so take the later of the two.
function saveBeatState(s: State) {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return; }
  const onDisk = loadState();
  writeState({
    ...s,
    strangerWatermarkMs: Math.max(onDisk.strangerWatermarkMs, s.strangerWatermarkMs),
    held: [...new Set([...onDisk.held, ...s.held])],
  });
}

// Latest arrival in a thread by timestamp rather than array position — the
// same rule the classifier uses. Individual unparseable timestamps are
// ignored; when NOTHING in the thread parses we return now, so the thread
// reads as newly arrived and clears the watermark. That deliberately
// re-notifies on every beat for as long as the anomaly persists — loud
// beats silent, and a stranger with a garbled clock deserves attention
// until it is handled. An unparseable timestamp must never mean "never
// notified".
function latestMs(t: MailThread): number {
  const times = t.messages.map((m) => Date.parse(m.timestamp)).filter((n) => !Number.isNaN(n));
  return times.length ? Math.max(...times) : Date.now();
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  // Strict argv, before any state read or network call: a typo like
  // `--dry-run` must print usage, never fall through into a live beat.
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    if (argv[0] !== '--hold' || argv.length !== 2 || !argv[1]) usage();
    const id = argv[1];
    const s = loadState();
    if (!s.held.includes(id)) s.held.push(id);
    writeState(s);
    console.log(`[glance] held ${id}`);
    return;
  }

  if (!KEY) abort('no AGENTMAIL_API_KEY in env; aborting', 2);

  const state = loadState();

  const sentRes = await get('/messages?limit=100') as { messages?: MailMessage[] };
  const sent = (sentRes.messages ?? []).filter((m) => m.labels?.includes('sent'));
  const known = knownFromSent(sent);

  const listRes = await get('/threads?limit=50') as { threads?: Array<{ threadId: string }> };
  const threads: MailThread[] = [];
  for (const t of listRes.threads ?? []) {
    threads.push(await get(`/threads/${encodeURIComponent(t.threadId)}`) as MailThread);
  }

  const { eligible, strangers } = classifyThreads(threads, known, INBOX, new Set(state.held));

  // Strangers: notify once per new arrival (watermark), content unread.
  const freshStrangers = strangers.filter((t) => latestMs(t) > state.strangerWatermarkMs);
  if (freshStrangers.length) {
    notify(`${freshStrangers.length} new thread(s) from unknown senders — quarantined, unread`);
    // Clamp every candidate to now before advancing. A single unsolicited
    // message stamped 2099 would otherwise push the watermark past every
    // real arrival and silence stranger notifications forever — a stranger
    // reaching in to switch off the notification half of the constraint.
    const now = Date.now();
    state.strangerWatermarkMs = Math.max(
      state.strangerWatermarkMs,
      ...freshStrangers.map((t) => Math.min(latestMs(t), now)),
    );
    saveBeatState(state);
  }

  // threadIds and messageIds are remote-controlled, and the thread ids are
  // the only such strings that reach the spawned session's instructions.
  // Reject rather than escape: a thread carrying an odd id is left for Marcus.
  const safe = eligible.filter((t) => hasSafeIds(t));
  const skipped = eligible.length - safe.length;
  if (skipped) {
    notify(`${skipped} eligible thread(s) skipped — unexpected characters in remote ids`);
  }

  if (!safe.length) { console.log(`[glance] ${new Date().toISOString()} nothing eligible`); return; }

  const ids = safe.map((t) => t.threadId);
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

main().catch((e) => {
  // Logged by launchd and surfaced to Marcus; the next beat retries.
  abort(`failed: ${e instanceof Error ? e.message : String(e)}`);
});
