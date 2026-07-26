import { getToken } from './clerk';

async function authHeaders(): Promise<Record<string, string>> {
  const t = await getToken();
  // X-Authorization mirrors Authorization: the exe.dev edge proxy strips the standard header.
  return t ? { Authorization: `Bearer ${t}`, 'X-Authorization': `Bearer ${t}` } : {};
}

async function post(path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res;
}

export const sendMessage = async (text: string) => { await post('/api/send', { message: text }); };
export const startSession = async () => { await post('/api/session/start', {}); };
export const endSession = async () => { await post('/api/session/end'); };

export interface ArtifactEntry { name: string; type: 'file' | 'folder'; modified?: number; children?: ArtifactEntry[] }
export async function fetchArtifactTree(): Promise<ArtifactEntry[]> {
  const res = await fetch('/api/artifacts', { headers: await authHeaders() });
  if (!res.ok) throw new Error(`artifacts → HTTP ${res.status}`);
  return (await res.json() as { entries: ArtifactEntry[] }).entries;
}
export async function fetchHealth() {
  const res = await fetch('/api/health');
  return res.json() as Promise<{ status: string; sessionActive: boolean; needsSetup: boolean; version: string }>;
}
