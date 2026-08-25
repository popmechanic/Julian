// scripts/lib/fireproof-map.ts — Fireproof message docs → stream rows, per the 2026-08-25 spec.
import { createStreamStore } from 'julian-shared/schema';
import type { DecodedDoc, MappedRow } from './fireproof-types';
import { FEB_START_MS, MAR_START_MS, MAX_CELL_JSON_BYTES } from './fireproof-types';

export function filterDocs(docs: DecodedDoc[]): { messages: DecodedDoc[]; droppedByType: Record<string, number> } {
  const messages: DecodedDoc[] = []; const droppedByType: Record<string, number> = {};
  for (const d of docs) {
    if (d.doc.type === 'message') messages.push(d);
    else { const t = typeof d.doc.type === 'string' ? d.doc.type : '(untyped)'; droppedByType[t] = (droppedByType[t] ?? 0) + 1; }
  }
  return { messages, droppedByType };
}

export function normalizeStrings<T>(v: T): T {
  if (typeof v === 'string') return v.replace(/[\u2028\u2029]/g, '\n') as T;
  if (Array.isArray(v)) return v.map(normalizeStrings) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalizeStrings(x)])) as T;
  return v;
}

const asStr = (x: unknown): string => (typeof x === 'string' ? x : '');

export function mapMessage(d: DecodedDoc): MappedRow | null {
  const doc = normalizeStrings(d.doc);
  const blocks = Array.isArray(doc.blocks) ? (doc.blocks as Array<Record<string, unknown>>) : [];
  let role = asStr(doc.role);
  if (!role) {
    if ('author' in doc && !('speakerType' in doc)) role = 'user';
    else role = doc.speakerType === 'human' ? 'user' : doc.speakerType === 'agent' ? 'assistant' : 'user';
  }
  let speakerName = asStr(doc.speakerName) || asStr(doc.author);
  if (speakerName.toLowerCase() === 'marcus') speakerName = 'Marcus';
  if (!speakerName) speakerName = role === 'assistant' ? 'Julian' : 'Marcus';
  const text = asStr(doc.text).trim()
    ? asStr(doc.text)
    : blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n');
  if (!text.trim()) return null;
  const ts = typeof doc.createdAt === 'number' ? doc.createdAt : Date.parse(asStr(doc.createdAt));
  const session = doc.serverSessionId == null || doc.serverSessionId === '' ? 'nosession' : String(doc.serverSessionId);
  const row: MappedRow = { id: String(doc._id), sessionId: `fireproof:${d.ledger.ledgerId}:${session}`, role, speakerName, text, ts, kind: 'chat' };
  if (role === 'assistant' && blocks.length) row.content = blocks;
  return row;
}

export function selectVersions(cands: Array<{ row: MappedRow; uploaded: number; blobId: string }>) {
  const byId = new Map<string, typeof cands>();
  for (const c of cands) byId.set(c.row.id, [...(byId.get(c.row.id) ?? []), c]);
  const winners: MappedRow[] = []; const violations: Array<{ id: string; note: string }> = [];
  for (const [id, vs] of byId) {
    vs.sort((a, b) => a.uploaded - b.uploaded || (a.blobId < b.blobId ? -1 : a.blobId > b.blobId ? 1 : 0));
    let winner = vs[vs.length - 1].row;
    const bad = vs.slice(0, -1).filter((v) => !winner.text.startsWith(v.row.text));
    if (bad.length) {
      violations.push({ id, note: `${bad.length} earlier version(s) not a prefix of the last; longest text wins` });
      winner = vs.map((v) => v.row).reduce((a, b) => (b.text.length > a.text.length ? b : a));
    }
    winners.push(winner);
  }
  return { winners, violations };
}

export function collapseSplits(rows: MappedRow[]) {
  const dropped: Array<{ id: string; keptId: string }> = []; const drop = new Set<string>();
  const groups = new Map<string, MappedRow[]>();
  rows.forEach((r) => { if (r.role === 'assistant') { const k = `${r.sessionId}|${r.ts}`; groups.set(k, [...(groups.get(k) ?? []), r]); } });
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i++) for (let j = 0; j < g.length; j++) {
      if (i === j || drop.has(g[i].id)) continue;
      const a = g[i].text, b = g[j].text;
      const strictPrefix = b.length > a.length && b.startsWith(a);
      const identicalEarlier = a === b && i < j;
      if (strictPrefix || identicalEarlier) { drop.add(g[i].id); dropped.push({ id: g[i].id, keptId: g[j].id }); break; }
    }
  }
  return { rows: rows.filter((r) => !drop.has(r.id)), dropped };
}

const ENC = new TextEncoder();
export const cellJsonBytes = (cell: unknown): number => ENC.encode(JSON.stringify(cell ?? '')).length;

function walkStrings(v: unknown, f: (s: string) => void): void {
  if (typeof v === 'string') f(v);
  else if (Array.isArray(v)) v.forEach((x) => walkStrings(x, f));
  else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walkStrings(x, f));
}

export function hardChecks(rows: MappedRow[], opts: { existing: Map<string, string>; allowIds?: Set<string> }) {
  const errors: string[] = [];
  for (const r of rows) {
    if (!Number.isFinite(r.ts)) errors.push(`ts not finite: ${r.id}`);
    else if (r.kind === 'chat' && (r.ts < FEB_START_MS || r.ts >= MAR_START_MS) && !opts.allowIds?.has(r.id)) errors.push(`ts out of range: ${r.id} ${new Date(r.ts).toISOString()}`);
    walkStrings({ text: r.text, speakerName: r.speakerName, sessionId: r.sessionId, content: r.content }, (s) => {
      if (s.startsWith('�') || s === '￼') errors.push(`reserved TinyBase prefix in ${r.id}`);
      if (!(s as string & { isWellFormed(): boolean }).isWellFormed()) errors.push(`lone surrogate in ${r.id}`);
      if (/[\u2028\u2029]/.test(s)) errors.push(`unnormalized line separator in ${r.id}`);
    });
    if (cellJsonBytes(r.text) > MAX_CELL_JSON_BYTES) errors.push(`text over 64 KiB: ${r.id}`);
    if (r.content && cellJsonBytes(r.content) > MAX_CELL_JSON_BYTES) errors.push(`content over 64 KiB: ${r.id}`);
    const ex = opts.existing.get(r.id);
    if (ex !== undefined && !ex.startsWith('fireproof:')) errors.push(`id exists on server with foreign session: ${r.id}`);
  }
  if (!errors.length) {
    try {
      const probe = createStreamStore('hard-check');
      for (const r of rows) { const { id, ...cells } = r; probe.setRow('messages', id, cells as never); }
      probe.getTables(); probe.getMergeableContent();
      if (probe.getRowIds('messages').length !== rows.length) errors.push('schema store rejected rows');
    } catch (e) { errors.push(`schema round-trip failed: ${String(e)}`); }
  }
  return errors.length ? { ok: false as const, errors } : { ok: true as const };
}

export function buildReceipt(rows: MappedRow[], writeDate: Date, sentence: string): MappedRow {
  const maxTs = rows.reduce((m, r) => Math.max(m, r.ts), -Infinity);
  return { id: `fireproof-import-${writeDate.toISOString().slice(0, 10)}`, sessionId: 'fireproof:import', role: 'system',
    speakerName: 'the record', text: sentence, ts: maxTs + 1, kind: 'system' };
}
