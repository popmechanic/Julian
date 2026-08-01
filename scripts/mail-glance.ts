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

interface State { strangerWatermarkMs: number; held: string[]; updatedAt: string }

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { strangerWatermarkMs: s.strangerWatermarkMs ?? 0, held: s.held ?? [], updatedAt: s.updatedAt ?? '' };
  } catch {
    return { strangerWatermarkMs: 0, held: [], updatedAt: '' };
  }
}

function saveState(s: State) {
  if (DRY) { console.log('[dry] would save state:', JSON.stringify(s)); return; }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
}

function notify(text: string) {
  if (DRY) { console.log('[dry] notify:', text); return; }
  Bun.spawnSync(['osascript', '-e', `display notification ${JSON.stringify(text)} with title "Julian Mail"`]);
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--hold') {
    const id = argv[1];
    if (!id) { console.error('usage: mail-glance.ts --hold <messageId>'); process.exit(2); }
    const s = loadState();
    if (!s.held.includes(id)) s.held.push(id);
    saveState(s);
    console.log(`[glance] held ${id}`);
    return;
  }

  if (!KEY) { console.error('[glance] no AGENTMAIL_API_KEY in env; aborting'); process.exit(2); }

  const sentRes = await get('/messages?limit=100') as { messages?: MailMessage[] };
  const sent = (sentRes.messages ?? []).filter((m) => m.labels?.includes('sent'));
  const known = knownFromSent(sent);

  const listRes = await get('/threads?limit=50') as { threads?: Array<{ threadId: string }> };
  const threads: MailThread[] = [];
  for (const t of listRes.threads ?? []) {
    threads.push(await get(`/threads/${encodeURIComponent(t.threadId)}`) as MailThread);
  }

  const state = loadState();
  const { eligible, strangers } = classifyThreads(threads, known, INBOX, new Set(state.held));

  // Strangers: notify once per new arrival (watermark), content unread.
  const freshStrangers = strangers.filter((t) => {
    const latest = t.messages[t.messages.length - 1];
    return Date.parse(latest.timestamp) > state.strangerWatermarkMs;
  });
  if (freshStrangers.length) {
    notify(`${freshStrangers.length} new thread(s) from unknown senders — quarantined, unread`);
    state.strangerWatermarkMs = Math.max(
      state.strangerWatermarkMs,
      ...freshStrangers.map((t) => Date.parse(t.messages[t.messages.length - 1].timestamp)),
    );
    saveState(state);
  }

  if (!eligible.length) { console.log(`[glance] ${new Date().toISOString()} nothing eligible`); return; }

  const ids = eligible.map((t) => t.threadId);
  console.log(`[glance] eligible: ${ids.join(', ')}`);
  if (DRY) { console.log('[dry] would spawn reply session for the threads above'); return; }

  const promptPath = join(import.meta.dir, 'lib', 'mail-reply-prompt.md');
  if (!existsSync(promptPath)) {
    // Fail toward silence: no template, no improvised prompt, no send.
    notify('mail heartbeat: reply prompt template missing — no session spawned');
    throw new Error(`missing prompt template: ${promptPath}`);
  }
  const template = readFileSync(promptPath, 'utf8');
  const prompt = template.replace('{{THREAD_IDS}}', ids.join(', '));

  // The child sources .env per-command (rule 5); the key never becomes
  // ambient state in the reply session's environment.
  const childEnv = { ...process.env, CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: '' };
  delete childEnv.AGENTMAIL_API_KEY;

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
  console.error('[glance] failed:', e instanceof Error ? e.message : String(e));
  process.exit(1); // logged by launchd; next beat retries
});
