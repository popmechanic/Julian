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

// Try to parse JSON starting from the first '{' in a string.
// If it fails and we have a pending buffer, try joining them.
function tryParseMarkerJSON(line: string, pending: string | null): { parsed: any; remaining: null } | null {
  const braceIdx = line.indexOf('{');
  if (braceIdx === -1) return null;

  const jsonStr = pending ? pending + line.slice(braceIdx) : line.slice(braceIdx);
  try {
    return { parsed: JSON.parse(jsonStr), remaining: null };
  } catch {
    return null;
  }
}

function emitMarker(
  type: string,
  parsed: any,
  appendFn: (partial: Omit<ServerEvent, 'id' | 'ts'>) => ServerEvent,
  sessionId: string | null,
): void {
  if (type === 'agent_registered') {
    if (!parsed.name || parsed.gridPosition == null) {
      console.warn('[Marker] AGENT_REGISTERED missing required fields (name, gridPosition):', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    if (!parsed.color) console.warn(`[Marker] AGENT_REGISTERED "${parsed.name}" missing color`);
    if (!parsed.colorName) console.warn(`[Marker] AGENT_REGISTERED "${parsed.name}" missing colorName`);
    if (!parsed.faceVariant) console.warn(`[Marker] AGENT_REGISTERED "${parsed.name}" missing faceVariant, using defaults`);
    appendFn({
      sessionId,
      type: 'agent_registered',
      agent: {
        name: parsed.name,
        color: parsed.color,
        colorName: parsed.colorName,
        gender: parsed.gender || 'man',
        gridPosition: parsed.gridPosition,
        faceVariant: parsed.faceVariant || { eyes: 'default', mouth: 'default' },
        individuationArtifact: parsed.individuationArtifact || '',
        createdAt: parsed.createdAt || new Date().toISOString(),
      },
    });
  } else if (type === 'agent_status') {
    if (!parsed.agents) {
      console.warn('[Marker] AGENT_STATUS missing agents array:', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    appendFn({ sessionId, type: 'agent_status', agents: parsed.agents });
  } else if (type === 'ui_action') {
    if (!parsed.target || !parsed.action) {
      console.warn('[Marker] UI_ACTION missing target or action:', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    appendFn({ sessionId, type: 'ui_action', target: parsed.target, action: parsed.action, data: parsed.data });
  }
}

export function parseMarkersFromContent(
  content: any[],
  appendFn: (partial: Omit<ServerEvent, 'id' | 'ts'>) => ServerEvent,
  sessionId: string | null,
): void {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const lines = block.text.split('\n');
      let pendingMarker: { type: string; text: string } | null = null;

      for (const line of lines) {
        // If we have a pending incomplete marker, try joining with this line
        if (pendingMarker) {
          const joined = pendingMarker.text + line;
          const result = tryParseMarkerJSON(joined, null);
          if (result) {
            emitMarker(pendingMarker.type, result.parsed, appendFn, sessionId);
            pendingMarker = null;
            continue;
          }
          // Still can't parse — drop the pending marker with a warning
          console.warn(`[Marker] Multi-line parse failed for ${pendingMarker.type}:`, pendingMarker.text.slice(0, 200));
          pendingMarker = null;
        }

        // [AGENT_REGISTERED] marker
        if (line.includes('[AGENT_REGISTERED]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_registered', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_registered', text: line };
          }
          continue;
        }

        // [AGENT_STATUS] marker
        if (line.includes('[AGENT_STATUS]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_status', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_status', text: line };
          }
          continue;
        }

        // [UI_ACTION] marker
        if (line.includes('[UI_ACTION]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('ui_action', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'ui_action', text: line };
          }
          continue;
        }
      }

      // Warn about any dangling pending marker at end of block
      if (pendingMarker) {
        console.warn(`[Marker] Incomplete ${pendingMarker.type} at end of content block:`, pendingMarker.text.slice(0, 200));
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
