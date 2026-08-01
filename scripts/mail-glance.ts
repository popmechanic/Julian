#!/usr/bin/env bun
// scripts/mail-glance.ts — the mechanical pulse (docs/mail-heartbeat.md).
// Counts, senders, eligibility. No content is read here and no LLM runs
// here; a fully-waked session handles anything eligible. Bun auto-loads
// the repo .env, which is this process's sanctioned key scope (rule 5).

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  classifyThreads, knownFromSent,
  type MailMessage, type MailThread,
} from './lib/mail-glance-lib';

const INBOX = 'julian-marcus@agentmail.to';
const API = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(INBOX)}`;
const KEY = process.env.AGENTMAIL_API_KEY;
const DRY = process.env.DRY_RUN === '1';
const STATE_DIR = join(homedir(), '.julian');
const STATE_PATH = join(STATE_DIR, 'mail-heartbeat.json');

// The whole alphabet an id may use before it reaches the spawned session's
// instructions. Ids outside it are skipped, never escaped.
const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

interface State { strangerWatermarkMs: number; held: string[]; updatedAt: string }

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
  process.exit(2);
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    abort(`state file is not valid JSON at ${STATE_PATH} — beat aborted, nothing sent`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    abort(`state file is not an object at ${STATE_PATH} — beat aborted, nothing sent`);
  }

  const s = parsed as Record<string, unknown>;
  const watermark = s.strangerWatermarkMs ?? 0;
  const held = s.held ?? [];
  if (typeof watermark !== 'number' || !Number.isFinite(watermark)) {
    abort(`state file has a bad strangerWatermarkMs at ${STATE_PATH} — beat aborted, nothing sent`);
  }
  if (!Array.isArray(held) || held.some((h) => typeof h !== 'string')) {
    abort(`state file has a bad held list at ${STATE_PATH} — beat aborted, nothing sent`);
  }
  return {
    strangerWatermarkMs: watermark,
    held: held as string[],
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
  };
}

function writeState(s: State) {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return; }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
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

function isSafeId(v: unknown): boolean {
  return typeof v === 'string' && SAFE_ID.test(v);
}

// threadIds and messageIds are remote-controlled, and the thread ids are the
// only such strings that reach the spawned session's instructions. Reject
// rather than escape: a thread carrying an odd id is left for Marcus.
function hasSafeIds(t: MailThread): boolean {
  return isSafeId(t.threadId) && t.messages.every((m) => isSafeId(m.messageId));
}

// Latest arrival in a thread by timestamp rather than array position — the
// same rule the classifier uses. Unparseable timestamps are ignored.
function latestMs(t: MailThread): number {
  const times = t.messages.map((m) => Date.parse(m.timestamp)).filter((n) => !Number.isNaN(n));
  return times.length ? Math.max(...times) : 0;
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
    state.strangerWatermarkMs = Math.max(
      state.strangerWatermarkMs,
      ...freshStrangers.map(latestMs),
    );
    saveBeatState(state);
  }

  const safe = eligible.filter(hasSafeIds);
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
