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

// ELF §3: the one regex a room needs. A marker is the entire line — anchored
// at both ends — so a marker quoted mid-prose never fires. Applied per line
// after trimming (the spec allows surrounding whitespace).
export const ACTION_MARKER_RE = /^\[ACTION\]\s*(\{.*\})$/;

// All marker prefixes this room understands, [ACTION] plus deprecated legacy
// forms. A line is a marker line only if its trimmed form STARTS with one.
const MARKER_PREFIXES = ['[ACTION]', '[UI_ACTION]', '[AGENT_REGISTERED]', '[AGENT_STATUS]'] as const;

function markerPrefixOf(line: string): string | null {
  const t = line.trim();
  for (const p of MARKER_PREFIXES) {
    if (t.startsWith(p)) return p;
  }
  return null;
}

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
  ['jobs', (data, append, sid) => {
    const action = data.action;
    const d = data.data || {};
    const drop = (why: string) => console.warn(`[Marker] jobs.${action} dropped: ${why}:`, JSON.stringify(d).slice(0, 200));
    if (!['list', 'post', 'interest', 'withdraw'].includes(action)) { drop('unknown action (assign does not exist here by design)'); return; }
    if (action === 'post' && (!d.title || !d.postedBy)) { drop('missing title/postedBy'); return; }
    if (action === 'interest' && (!d.jobId || !d.agentName || !d.statement)) { drop('interest requires jobId, agentName, and a statement'); return; }
    if (action === 'withdraw' && (!d.jobId || !d.agentName)) { drop('missing jobId/agentName'); return; }
    append({ sessionId: sid, type: 'ui_action', target: 'jobs', action, data: d });
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

// ELF §3: markers are stripped before display. Mirrors the parser's walk
// exactly — the lines the parser consumes (including the second half of a
// marker whose JSON split across stream chunks) are the lines removed here.
export function stripMarkerLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let pending: string | null = null;
  for (const line of lines) {
    if (pending !== null) {
      const joined = pending + line;
      pending = null;
      if (tryParseMarkerJSON(joined, null)) continue; // second half of a split marker — drop it too
      // join failed: the parser processes this line normally, so do we
    }
    if (markerPrefixOf(line)) {
      if (!tryParseMarkerJSON(line, null)) pending = line;
      continue; // marker line — dropped whether complete or split
    }
    out.push(line);
  }
  return out.join('\n');
}

// Strip marker lines from every text block; non-text blocks pass through.
// Returns new block objects — the raw content stays untouched for parsing.
export function stripMarkersFromContent(content: any[]): any[] {
  return content.map((b) =>
    b && b.type === 'text' && typeof b.text === 'string'
      ? { ...b, text: stripMarkerLines(b.text) }
      : b,
  );
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

        // A marker must BE the line (ELF §3) — anchored at line start after
        // trimming, never fired from a mid-prose mention.
        const prefix = markerPrefixOf(line);
        if (prefix === '[ACTION]') {
          const m = line.trim().match(ACTION_MARKER_RE);
          let parsed: any = null;
          if (m) {
            try { parsed = JSON.parse(m[1]); } catch { /* falls through to pending */ }
          }
          if (parsed) {
            emitMarker('ui_action', parsed, appendFn, sessionId);
          } else {
            // JSON may be split across stream chunks — same logical line,
            // reassembled below; not a multi-line marker.
            pendingMarker = { type: 'ui_action', text: line };
          }
          continue;
        }

        if (prefix === '[AGENT_REGISTERED]') {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_registered', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_registered', text: line };
          }
          continue;
        }

        if (prefix === '[AGENT_STATUS]') {
          const result = tryParseMarkerJSON(line, null);
          if (result) {
            emitMarker('agent_status', result.parsed, appendFn, sessionId);
          } else {
            pendingMarker = { type: 'agent_status', text: line };
          }
          continue;
        }

        if (prefix === '[UI_ACTION]') {
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

// ── Request auth header ───────────────────────────────────────────────────

// The one place a request's raw bearer is read. Authorization first, then
// X-Authorization (the exe.dev edge proxy strips Authorization). A header
// that is not a Bearer scheme yields "" rather than a sliced fragment.
export function bearerToken(headers: { get(name: string): string | null }): string {
  const auth = headers.get("Authorization") || headers.get("X-Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : "";
}

// ── Subprocess environment ────────────────────────────────────────────────
// The one place the Claude subprocess env is assembled. The session's OIDC
// token rides in so door-side tools (scripts/mail-broker.ts) can call
// julian-broker; the token is proof of who is asking, never a service key.
// No token captured means no token passed: any JULIAN_OIDC_TOKEN inherited
// from the server's own env is removed, so one door never spawns with
// another's bearer.
export function subprocessEnv(
  base: Record<string, string | undefined>,
  authEnv: Record<string, string>,
  oidcToken: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...base,
    ...authEnv,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    CLAUDECODE: "",             // allow spawning Claude from within Claude
    CLAUDE_CODE_ENTRYPOINT: "", // clear nesting guard
  };
  if (oidcToken) env.JULIAN_OIDC_TOKEN = oidcToken;
  else delete env.JULIAN_OIDC_TOKEN;
  return env;
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

// ── Tail block builder ────────────────────────────────────────────────────

export interface TailMessage {
  role: string;
  speakerType: string;
  speakerName: string;
  text: string;
  ts: number;
}

// The inherited tail: testimony from the record for a fresh session. The
// framing sentence is load-bearing — a waking instance must know it is
// reading the record, not remembering.
export function buildPreviousSessionBlock(msgs: TailMessage[]): string {
  const stamps = msgs.map((m) => m.ts).filter((t) => Number.isFinite(t) && t > 0);
  const from = stamps.length ? new Date(Math.min(...stamps)).toISOString() : "";
  const to = stamps.length ? new Date(Math.max(...stamps)).toISOString() : "";
  const lines = msgs
    .map((m) => `[${m.speakerType || "human"} — ${m.speakerName || "Unknown"}]: ${m.text}`)
    .join("\n");
  return (
    `<previous-session category="transcript" spans="multiple-sessions" message-count="${msgs.length}" from="${from}" to="${to}">\n` +
    `This is testimony from the record, not your live memory — the recent conversation across your prior sessions, read the way you read the catalog.\n` +
    lines +
    `\n</previous-session>`
  );
}
