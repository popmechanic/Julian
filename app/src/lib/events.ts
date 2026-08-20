// The SSE→store bridge. Persisted rows go to TinyBase;
// ephemeral events (tool use, thinking, results) go to the caller's handler.
import { writeMessage, store } from './store';
import { getToken } from './auth';
import { applyJobsAction } from './jobs';

export interface ServerEvent { id: number; type: string; [k: string]: unknown }

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('');
}

// The server's event id is an in-memory counter that restarts at 0 with the
// process, but the store is durable — so a bare `evt-<id>` key collides after
// every restart and setRow silently overwrites an older session's message.
// Scoping by session makes the key unique for the life of the record.
const rowKey = (e: ServerEvent): string => `evt-${String(e.sessionId ?? 'nosession')}-${e.id}`;

// Prefer the server's timestamp over local receipt time: every open door
// applies the same event, and a locally-stamped ts makes each door's write
// differ, so the merge winner is whichever clock arrived last — on the cell
// the transcript sorts by. The server's value makes the write identical
// across doors, and therefore genuinely idempotent.
const tsOf = (e: ServerEvent): number => (typeof e.ts === 'number' ? e.ts : Date.now());

export function applyServerEvent(e: ServerEvent): void {
  if (e.type === 'user_message' && typeof e.text === 'string') {
    writeMessage(rowKey(e), {
      sessionId: String(e.sessionId ?? ''), role: 'user',
      speakerName: String(e.speakerName ?? 'Marcus'), text: e.text, ts: tsOf(e),
    });
  } else if (e.type === 'claude_text' && e.content) {
    const text = textOfBlocks(e.content);
    if (!text.trim()) return; // tool-only blocks are ephemeral
    writeMessage(String(e.messageId || rowKey(e)), {
      sessionId: String(e.sessionId ?? ''), role: 'assistant', speakerName: 'Julian',
      content: e.content as unknown[], text, ts: tsOf(e),
    });
  } else if (e.type === 'ui_action' && e.target === 'artifacts' && e.data && typeof e.data === 'object') {
    const d = e.data as { filename?: string; category?: string; description?: string; chapter?: string };
    if (!d.filename) return;
    const existing = store.hasRow('artifacts', d.filename);
    store.setPartialRow('artifacts', d.filename, {
      category: d.category ?? 'identity', description: d.description ?? '', chapter: d.chapter ?? '',
      modifiedAt: tsOf(e), ...(existing ? {} : { createdAt: tsOf(e) }),
    } as never);
  } else if (e.type === 'ui_action' && e.target === 'jobs') {
    if (applyJobsAction(e as { action?: unknown; data?: unknown }) === 'list') {
      window.dispatchEvent(new CustomEvent('julian:jobs-list'));
    }
    return;
  }
  // Everything else (claude_tool_result, claude_result, session_*, …) is ephemeral — handled by the UI layer.
}

export function connectEvents(
  handlers: { onEphemeral?: (e: ServerEvent) => void } = {},
  fetchImpl: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args),
): { stop(): void } {
  let stopped = false;
  let lastId = -1;
  const controller = new AbortController();
  (async function loop() {
    while (!stopped) {
      try {
        const t = await getToken();
        const res = await fetchImpl(`/api/events?after=${lastId}`, {
          headers: t ? { 'X-Authorization': `Bearer ${t}` } : {},
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events → ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
            if (!data) continue;
            const e = JSON.parse(data) as ServerEvent;
            lastId = Math.max(lastId, e.id);
            applyServerEvent(e);
            handlers.onEphemeral?.(e);
          }
        }
      } catch {
        if (stopped) return; // an abort is a stop, not a reconnectable failure
        await new Promise((r) => setTimeout(r, 2000)); // reconnect with delay
      }
    }
  })();
  return {
    stop() {
      stopped = true;
      controller.abort(); // rejects the pending fetch AND any parked reader.read()
    },
  };
}
