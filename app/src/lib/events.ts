// The SSE→store bridge. Persisted rows go to TinyBase;
// ephemeral events (tool use, thinking, results) go to the caller's handler.
import { writeMessage, store } from './store';
import { getToken } from './clerk';

export interface ServerEvent { id: number; type: string; [k: string]: unknown }

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('');
}

export function applyServerEvent(e: ServerEvent): void {
  if (e.type === 'user_message' && typeof e.text === 'string') {
    writeMessage(`evt-${e.id}`, {
      sessionId: String(e.sessionId ?? ''), role: 'user',
      speakerName: String(e.speakerName ?? 'Marcus'), text: e.text, ts: Date.now(),
    });
  } else if (e.type === 'claude_text' && e.content) {
    const text = textOfBlocks(e.content);
    if (!text.trim()) return; // tool-only blocks are ephemeral
    writeMessage(String(e.messageId || `evt-${e.id}`), {
      sessionId: String(e.sessionId ?? ''), role: 'assistant', speakerName: 'Julian',
      content: e.content as unknown[], text, ts: Date.now(),
    });
  } else if (e.type === 'ui_action' && e.target === 'artifacts' && e.data && typeof e.data === 'object') {
    const d = e.data as { filename?: string; category?: string; description?: string; chapter?: string };
    if (!d.filename) return;
    const existing = store.hasRow('artifacts', d.filename);
    store.setPartialRow('artifacts', d.filename, {
      category: d.category ?? 'identity', description: d.description ?? '', chapter: d.chapter ?? '',
      modifiedAt: Date.now(), ...(existing ? {} : { createdAt: Date.now() }),
    } as never);
  }
  // Everything else (claude_tool_result, claude_result, session_*, …) is ephemeral — handled by the UI layer.
}

export function connectEvents(handlers: { onEphemeral?: (e: ServerEvent) => void } = {}): { stop(): void } {
  let stopped = false;
  let lastId = -1;
  (async function loop() {
    while (!stopped) {
      try {
        const t = await getToken();
        const res = await fetch(`/api/events?after=${lastId}`, {
          headers: t ? { 'X-Authorization': `Bearer ${t}` } : {},
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
        await new Promise((r) => setTimeout(r, 2000)); // reconnect with delay
      }
    }
  })();
  return { stop() { stopped = true; } };
}
