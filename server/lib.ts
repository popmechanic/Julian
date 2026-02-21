import { createHash, randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ServerEvent {
  id: number;
  ts: number;
  sessionId: string | null;
  type: string;
  [key: string]: any;
}

// ── PKCE helpers ──────────────────────────────────────────────────────────

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

// ── Env parsing ───────────────────────────────────────────────────────────

export function parseEnvContent(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

// ── Credential parsers ────────────────────────────────────────────────────

export function parseClaudeCredentials(data: any): { accessToken: string; expiresAt: number } | null {
  const token = data?.claudeAiOauth?.accessToken;
  const expiresAt = data?.claudeAiOauth?.expiresAt;
  if (typeof token === "string" && token.length > 0) {
    return { accessToken: token, expiresAt: expiresAt ?? 0 };
  }
  return null;
}

export function parseSculptorCredentials(data: any): { access_token: string; expires_at_unix_ms: number } | null {
  const token = data?.anthropic?.access_token;
  const expiresAt = data?.anthropic?.expires_at_unix_ms;
  if (typeof token === "string" && token.length > 0) {
    return { access_token: token, expires_at_unix_ms: expiresAt ?? 0 };
  }
  return null;
}

// ── CORS headers ──────────────────────────────────────────────────────────

export function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Authorization",
    "Access-Control-Expose-Headers": "X-Session-Id",
  };
}

// ── Marker parsing ────────────────────────────────────────────────────────

export function parseMarkersFromContent(
  content: any[],
  appendFn: (partial: Omit<ServerEvent, 'id' | 'ts'>) => ServerEvent,
  sessionId: string | null,
): void {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      // [AGENT_REGISTERED] marker
      const regLines = block.text.split('\n').filter((l: string) => l.includes('[AGENT_REGISTERED]'));
      for (const line of regLines) {
        try {
          const jsonStr = line.slice(line.indexOf('{'));
          const agent = JSON.parse(jsonStr);
          if (agent.name && agent.gridPosition != null) {
            appendFn({
              sessionId,
              type: 'agent_registered',
              agent: {
                name: agent.name,
                color: agent.color,
                colorName: agent.colorName,
                gender: agent.gender || 'man',
                gridPosition: agent.gridPosition,
                faceVariant: agent.faceVariant || { eyes: 'default', mouth: 'default' },
                individuationArtifact: agent.individuationArtifact || '',
                createdAt: agent.createdAt || new Date().toISOString(),
              },
            });
          }
        } catch {}
      }

      // [AGENT_STATUS] marker
      const statusLines = block.text.split('\n').filter((l: string) => l.includes('[AGENT_STATUS]'));
      for (const line of statusLines) {
        try {
          const jsonStr = line.slice(line.indexOf('{'));
          const status = JSON.parse(jsonStr);
          if (status.agents) {
            appendFn({ sessionId, type: 'agent_status', agents: status.agents });
          }
        } catch {}
      }

      // [UI_ACTION] marker
      const uiActionLines = block.text.split('\n').filter((l: string) => l.includes('[UI_ACTION]'));
      for (const line of uiActionLines) {
        try {
          const jsonStr = line.slice(line.indexOf('{'));
          const parsed = JSON.parse(jsonStr);
          if (parsed.target && parsed.action) {
            appendFn({ sessionId, type: 'ui_action', target: parsed.target, action: parsed.action, data: parsed.data });
          }
        } catch {}
      }
    }

    // Detect Write tool targeting memory/
    if (block.type === 'tool_use' && block.name === 'Write') {
      const filePath = block.input?.file_path || '';
      if (filePath.includes('memory/') && (filePath.endsWith('.html') || filePath.endsWith('.md'))) {
        const filename = filePath.split('/').pop() || '';
        appendFn({
          sessionId,
          type: 'artifact_written',
          filename,
          path: filePath,
          isNew: true,
          sizeBytes: (block.input?.content || '').length,
          meta: null,
        });
      }
    }

    // Detect Bash tool targeting JulianScreen
    if (block.type === 'tool_use' && block.name === 'Bash') {
      const cmd = block.input?.command || '';
      if (cmd.includes('localhost:3848/cmd')) {
        const dMatch = cmd.match(/-d\s+'([^']+)'/) || cmd.match(/-d\s+"([^"]+)"/);
        const command = dMatch ? dMatch[1] : cmd;
        const faceMatch = command.match(/FACE\s+(\w+)/);
        appendFn({
          sessionId,
          type: 'screen_command',
          command,
          ...(faceMatch ? { expression: faceMatch[1] } : {}),
        });
      }
    }
  }
}

// ── Event log factory ─────────────────────────────────────────────────────

export interface EventLog {
  append: (partial: Omit<ServerEvent, 'id' | 'ts'>) => ServerEvent;
  eventsAfter: (afterId: number) => ServerEvent[];
  subscribe: (fn: (event: ServerEvent) => void) => void;
  unsubscribe: (fn: (event: ServerEvent) => void) => void;
  subscribers: Set<(event: ServerEvent) => void>;
}

export function createEventLog(maxEvents: number): EventLog {
  const eventLog: ServerEvent[] = [];
  let nextEventId = 0;
  const subscribers = new Set<(event: ServerEvent) => void>();

  function append(partial: Omit<ServerEvent, 'id' | 'ts'>): ServerEvent {
    const event: ServerEvent = {
      ...partial,
      id: nextEventId++,
      ts: Date.now(),
    };
    eventLog.push(event);
    if (eventLog.length > maxEvents) eventLog.shift();
    for (const notify of subscribers) {
      try { notify(event); } catch {}
    }
    return event;
  }

  function eventsAfter(afterId: number): ServerEvent[] {
    return eventLog.filter(e => e.id > afterId);
  }

  function subscribe(fn: (event: ServerEvent) => void) {
    subscribers.add(fn);
  }

  function unsubscribe(fn: (event: ServerEvent) => void) {
    subscribers.delete(fn);
  }

  return { append, eventsAfter, subscribe, unsubscribe, subscribers };
}
