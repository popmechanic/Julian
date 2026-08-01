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
    const latest = t.messages[t.messages.length - 1];
    if (!latest) continue;
    if (extractAddress(latest.from) === self) continue;
    if (held.has(latest.messageId)) continue;
    if (isAutomated(latest)) continue;
    (known.has(extractAddress(latest.from)) ? eligible : strangers).push(t);
  }
  return { eligible, strangers };
}
