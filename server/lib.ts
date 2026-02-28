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

// Target-based handler map for unified [ACTION] markers
type AppendFn = (partial: Omit<ServerEvent, 'id' | 'ts'>) => ServerEvent;

const markerHandlers = new Map<string, (data: any, append: AppendFn, sid: string | null) => void>([
  ['agents', (data, append, sid) => {
    if (data.action === 'register') {
      const d = data.data || {};
      if (!d.name || d.gridPosition == null) {
        console.warn('[Marker] agents.register missing required fields (name, gridPosition):', JSON.stringify(d).slice(0, 200));
        return;
      }
      if (!d.color) console.warn(`[Marker] agents.register "${d.name}" missing color`);
      if (!d.colorName) console.warn(`[Marker] agents.register "${d.name}" missing colorName`);
      if (!d.faceVariant) console.warn(`[Marker] agents.register "${d.name}" missing faceVariant, using defaults`);
      append({
        sessionId: sid,
        type: 'ui_action',
        target: 'agents',
        action: 'register',
        data: {
          name: d.name,
          color: d.color,
          colorName: d.colorName,
          gender: d.gender || 'man',
          gridPosition: d.gridPosition,
          faceVariant: d.faceVariant || { eyes: 'default', mouth: 'default' },
          individuationArtifact: d.individuationArtifact || '',
          createdAt: d.createdAt || new Date().toISOString(),
        },
      });
    } else if (data.action === 'status') {
      const d = data.data || {};
      if (!d.agents) {
        console.warn('[Marker] agents.status missing agents array:', JSON.stringify(d).slice(0, 200));
        return;
      }
      append({ sessionId: sid, type: 'ui_action', target: 'agents', action: 'status', data: d });
    }
  }],
  ['job-form', (data, append, sid) => {
    append({ sessionId: sid, type: 'ui_action', target: 'job-form', action: data.action, data: data.data });
  }],
]);

function emitMarker(
  type: string,
  parsed: any,
  appendFn: AppendFn,
  sessionId: string | null,
): void {
  if (type === 'ui_action') {
    // Unified [ACTION] path — route by target
    if (!parsed.target || !parsed.action) {
      console.warn('[Marker] ACTION missing target or action:', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    const handler = markerHandlers.get(parsed.target);
    if (handler) {
      handler(parsed, appendFn, sessionId);
    } else {
      // Unknown target — pass through as generic ui_action
      appendFn({ sessionId, type: 'ui_action', target: parsed.target, action: parsed.action, data: parsed.data });
    }
  } else if (type === 'agent_registered') {
    // Backward compat: translate to unified format
    if (!parsed.name || parsed.gridPosition == null) {
      console.warn('[Marker] AGENT_REGISTERED missing required fields (name, gridPosition):', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    const handler = markerHandlers.get('agents')!;
    handler({ action: 'register', data: parsed }, appendFn, sessionId);
  } else if (type === 'agent_status') {
    // Backward compat: translate to unified format
    if (!parsed.agents) {
      console.warn('[Marker] AGENT_STATUS missing agents array:', JSON.stringify(parsed).slice(0, 200));
      return;
    }
    const handler = markerHandlers.get('agents')!;
    handler({ action: 'status', data: parsed }, appendFn, sessionId);
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

        // [ACTION] marker (primary unified format)
        if (line.includes('[ACTION]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('ui_action', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'ui_action', text: line };
          }
          continue;
        }

        // [AGENT_REGISTERED] marker (backward compat — deprecated)
        if (line.includes('[AGENT_REGISTERED]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_registered', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_registered', text: line };
          }
          continue;
        }

        // [AGENT_STATUS] marker (backward compat — deprecated)
        if (line.includes('[AGENT_STATUS]')) {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_status', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_status', text: line };
          }
          continue;
        }

        // [UI_ACTION] marker (backward compat — deprecated, use [ACTION])
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
