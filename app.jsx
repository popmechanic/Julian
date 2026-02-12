import React, { useState, useEffect, useRef, useCallback } from "react";
import { useFireproofClerk } from "use-fireproof";

/* ── Utilities ───────────────────────────────────────────────────────────── */

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.length <= maxLen ? str : str.slice(0, maxLen) + '\u2026';
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre style="background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:12px 16px;overflow-x:auto;font-size:13px;line-height:1.5;margin:8px 0"><code>${code.trim()}</code></pre>`
  );
  html = html.replace(/`([^`]+)`/g,
    '<code style="background:rgba(99,102,241,0.15);padding:2px 6px;border-radius:4px;font-size:0.9em">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

function formatToolInput(toolName, input) {
  if (!input) return '';
  if (typeof input === 'string') return escapeHtml(truncate(input, 300));
  if (toolName === 'Read' && input.file_path) return escapeHtml(input.file_path);
  if (toolName === 'Write' && input.file_path) return escapeHtml(input.file_path);
  if (toolName === 'Edit' && input.file_path) return escapeHtml(input.file_path);
  if (toolName === 'Bash' && input.command) return '$ ' + escapeHtml(truncate(input.command, 200));
  if (toolName === 'Glob' && input.pattern) return escapeHtml(input.pattern);
  if (toolName === 'Grep' && input.pattern) return escapeHtml(input.pattern);
  try { return escapeHtml(truncate(JSON.stringify(input, null, 2), 300)); } catch { return ''; }
}

/* ── Design components ───────────────────────────────────────────────────── */

function GlowOrbs() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden" style={{ zIndex: 0 }}>
      <div className="absolute rounded-full" style={{
        width: 600, height: 600, top: '-10%', left: '-8%',
        background: 'radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)',
        filter: 'blur(80px)', animation: 'drift1 18s ease-in-out infinite alternate',
      }} />
      <div className="absolute rounded-full" style={{
        width: 500, height: 500, bottom: '-5%', right: '-5%',
        background: 'radial-gradient(circle, rgba(168,85,247,0.10) 0%, transparent 70%)',
        filter: 'blur(90px)', animation: 'drift2 22s ease-in-out infinite alternate',
      }} />
      <div className="absolute rounded-full" style={{
        width: 350, height: 350, top: '40%', right: '20%',
        background: 'radial-gradient(circle, rgba(34,211,238,0.08) 0%, transparent 70%)',
        filter: 'blur(70px)', animation: 'drift3 15s ease-in-out infinite alternate',
      }} />
    </div>
  );
}

function StatusBadge({ ok }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium tracking-wide" style={{
      background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
      color: ok ? '#4ade80' : '#f87171',
      border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
    }}>
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{
        backgroundColor: ok ? '#4ade80' : '#f87171',
        boxShadow: ok ? '0 0 6px #4ade80' : '0 0 6px #f87171',
      }} />
      {ok ? 'CONNECTED' : 'OFFLINE'}
    </span>
  );
}

function GlassCard({ children, className = '' }) {
  return (
    <div className={`rounded-2xl p-6 ${className}`} style={{
      background: 'rgba(255,255,255,0.03)',
      backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>{children}</div>
  );
}

function FeaturePill({ icon, label }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium" style={{
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)',
    }}>
      <span style={{ fontSize: 14 }}>{icon}</span>{label}
    </span>
  );
}

/* ── Chat components ─────────────────────────────────────────────────────── */

function ThinkingDots() {
  return (
    <div className="flex items-center gap-2 px-1 py-3">
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full" style={{
            backgroundColor: '#6366f1',
            animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
      <span className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>Thinking</span>
    </div>
  );
}

function ToolCallBlock({ name, input }) {
  return (
    <div className="rounded-lg my-2 overflow-hidden" style={{
      background: 'rgba(0,0,0,0.25)',
      borderLeft: '3px solid rgba(99,102,241,0.5)',
    }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}>
        <span className="text-xs font-medium" style={{ color: '#818cf8' }}>{name}</span>
      </div>
      <div className="px-3 py-2 text-xs" style={{
        color: 'rgba(255,255,255,0.4)',
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {formatToolInput(name, input)}
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4">
        <div className="rounded-2xl px-4 py-3 text-sm max-w-[80%] leading-relaxed" style={{
          background: 'linear-gradient(135deg, rgba(99,102,241,0.25), rgba(168,85,247,0.2))',
          border: '1px solid rgba(99,102,241,0.3)',
          color: '#e0e7ff',
        }}>
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-full w-full">
        {message.thinking && <ThinkingDots />}
        {message.blocks && message.blocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className="text-sm leading-relaxed px-1" style={{ color: 'rgba(255,255,255,0.8)' }}>
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
              </div>
            );
          }
          if (block.type === 'tool_use') {
            return <ToolCallBlock key={i} name={block.name} input={block.input} />;
          }
          return null;
        })}
        {message.streaming && !message.thinking && (
          <span className="inline-block w-0.5 h-4 ml-1" style={{
            backgroundColor: '#6366f1',
            animation: 'blink 1s step-end infinite',
            verticalAlign: 'text-bottom',
          }} />
        )}
      </div>
    </div>
  );
}

/* ── Artifact Viewer ─────────────────────────────────────────────────────── */

function ArtifactViewer({ activeArtifact, artifacts, onSelect, getAuthHeaders }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div className="flex flex-col h-full" style={{
      borderLeft: '1px solid rgba(255,255,255,0.06)',
    }}>
      {/* Artifact header */}
      <div className="flex items-center gap-3 px-4 py-3" style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(9,9,11,0.8)',
        backdropFilter: 'blur(20px)',
        minHeight: 56,
      }}>
        <span className="text-xs font-mono tracking-widest" style={{ color: 'rgba(255,255,255,0.3)' }}>
          ARTIFACT
        </span>

        {/* Dropdown selector */}
        <div className="relative flex-1" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer w-full"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: activeArtifact ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)',
              textAlign: 'left',
            }}
          >
            <span className="flex-1 truncate">{activeArtifact || 'Select artifact...'}</span>
            <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>
              {dropdownOpen ? '\u25B2' : '\u25BC'}
            </span>
          </button>

          {dropdownOpen && artifacts.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 rounded-lg overflow-hidden" style={{
              background: 'rgba(15,15,20,0.95)',
              border: '1px solid rgba(255,255,255,0.1)',
              backdropFilter: 'blur(20px)',
              zIndex: 50,
              maxHeight: 300,
              overflowY: 'auto',
            }}>
              {artifacts.map(f => (
                <button
                  key={f.name}
                  onClick={() => { onSelect(f.name); setDropdownOpen(false); }}
                  className="w-full text-left px-3 py-2 text-xs transition-colors cursor-pointer"
                  style={{
                    color: f.name === activeArtifact ? '#818cf8' : 'rgba(255,255,255,0.6)',
                    background: f.name === activeArtifact ? 'rgba(99,102,241,0.1)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                  onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.05)'}
                  onMouseLeave={e => e.target.style.background = f.name === activeArtifact ? 'rgba(99,102,241,0.1)' : 'transparent'}
                >
                  {f.name}
                  <span className="ml-2" style={{ color: 'rgba(255,255,255,0.2)' }}>
                    {new Date(f.modified).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Open in new tab */}
        {activeArtifact && (
          <a
            href={'/api/artifacts/' + encodeURIComponent(activeArtifact)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-2.5 py-1.5 text-xs transition-all cursor-pointer"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.4)',
              textDecoration: 'none',
            }}
            title="Open in new tab"
          >
            &#8599;
          </a>
        )}
      </div>

      {/* iframe or empty state */}
      {activeArtifact ? (
        <iframe
          key={activeArtifact}
          src={'/api/artifacts/' + encodeURIComponent(activeArtifact)}
          className="flex-1 w-full"
          style={{
            border: 'none',
            background: '#fff',
          }}
          title={activeArtifact}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-2xl mb-3" style={{ opacity: 0.15 }}>&#9671;</div>
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.2)' }}>
              {artifacts.length > 0
                ? 'Select an artifact to view'
                : 'Artifacts will appear here when Julian creates them'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Setup Screen ────────────────────────────────────────────────────────── */

function SetupScreen({ onComplete, getAuthHeaders }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | polling | error
  const [error, setError] = useState('');

  const handleConnect = useCallback(async () => {
    const trimmed = token.replace(/\s+/g, '');
    if (!trimmed) return;
    if (!trimmed.startsWith('sk-ant-oat')) {
      setError('Token must start with sk-ant-oat (run claude setup-token to generate one)');
      return;
    }
    setStatus('loading');
    setError('');
    try {
      const headers = await getAuthHeaders();
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Setup failed');
        setStatus('error');
        return;
      }
      // Poll health until process is alive
      setStatus('polling');
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const h = await getAuthHeaders();
          const hr = await fetch('/api/health', { headers: h });
          const hd = await hr.json();
          if (hd.processAlive && !hd.needsSetup) {
            onComplete();
            return;
          }
        } catch {}
      }
      setError('Claude process did not start. Check server logs.');
      setStatus('error');
    } catch (err) {
      setError('Connection error: ' + err.message);
      setStatus('error');
    }
  }, [token, getAuthHeaders, onComplete]);

  const isLoading = status === 'loading' || status === 'polling';

  return (
    <div className="relative min-h-screen flex items-center justify-center p-6" style={{ zIndex: 1 }}>
      <div className="w-full max-w-lg flex flex-col gap-6">
        <div className="text-center">
          <div className="inline-flex w-12 h-12 rounded-xl items-center justify-center mb-4" style={{
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            boxShadow: '0 4px 20px rgba(99,102,241,0.4)',
          }}>
            <span className="text-white text-lg font-bold font-mono">&gt;_</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Connect to Claude</h1>
          <p className="text-sm mt-2" style={{ color: 'rgba(255,255,255,0.45)' }}>
            One-time setup to link your Claude account
          </p>
        </div>

        <GlassCard className="flex flex-col gap-5">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold" style={{
                background: 'rgba(99,102,241,0.2)', color: '#818cf8',
              }}>1</span>
              <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
                Generate a setup token
              </span>
            </div>
            <div className="rounded-lg px-4 py-3" style={{
              background: 'rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.06)',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
            }}>
              <span style={{ color: 'rgba(255,255,255,0.35)' }}>$</span>{' '}
              <span style={{ color: '#e2e8f0' }}>claude setup-token</span>
            </div>
            <p className="text-xs mt-2" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Run this in any terminal where Claude CLI is installed. It will output a long-lived token.
            </p>
          </div>

          <div className="h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold" style={{
                background: 'rgba(99,102,241,0.2)', color: '#818cf8',
              }}>2</span>
              <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
                Paste the token
              </span>
            </div>
            <input
              value={token}
              onChange={e => { setToken(e.target.value); setError(''); }}
              placeholder="sk-ant-oat01-..."
              disabled={isLoading}
              className="w-full rounded-lg px-4 py-3 text-sm outline-none"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: `1px solid ${error ? 'rgba(239,68,68,0.4)' : 'rgba(255,255,255,0.08)'}`,
                color: '#e2e8f0',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
                opacity: isLoading ? 0.5 : 1,
              }}
            />
            {error && (
              <p className="text-xs mt-2" style={{ color: '#f87171' }}>{error}</p>
            )}
          </div>

          <button
            onClick={handleConnect}
            disabled={isLoading || !token.trim()}
            className="w-full rounded-xl py-3 text-sm font-medium transition-all duration-200 cursor-pointer"
            style={{
              background: (isLoading || !token.trim())
                ? 'rgba(99,102,241,0.3)'
                : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color: '#fff',
              border: 'none',
              boxShadow: (isLoading || !token.trim()) ? 'none' : '0 4px 14px rgba(99,102,241,0.3)',
            }}
          >
            {status === 'loading' ? 'Saving...' : status === 'polling' ? 'Starting Claude...' : 'Connect'}
          </button>
        </GlassCard>

        <p className="text-center text-xs" style={{ color: 'rgba(255,255,255,0.15)' }}>
          Advanced: set <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>ANTHROPIC_API_KEY</span> via SSH for API key auth
        </p>
      </div>
    </div>
  );
}

/* ── Chat input ──────────────────────────────────────────────────────────── */

function ChatInput({ onSend, disabled }) {
  const [input, setInput] = useState('');
  const inputRef = useRef(null);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || disabled) return;
    onSend(text);
    setInput('');
  }, [input, disabled, onSend]);

  useEffect(() => {
    if (!disabled && inputRef.current) inputRef.current.focus();
  }, [disabled]);

  return (
    <div className="flex gap-2">
      <input
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
        placeholder={disabled ? "Claude is responding\u2026" : "Type a message\u2026"}
        disabled={disabled}
        className="flex-1 rounded-xl px-4 py-3 text-sm outline-none"
        style={{
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#e2e8f0',
          fontFamily: "'Inter', sans-serif",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled}
        className="rounded-xl px-5 py-3 text-sm font-medium transition-all duration-200 cursor-pointer"
        style={{
          background: disabled ? 'rgba(99,102,241,0.3)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
          color: '#fff',
          border: 'none',
          boxShadow: disabled ? 'none' : '0 4px 14px rgba(99,102,241,0.3)',
        }}
      >
        Send
      </button>
    </div>
  );
}

/* ── Conversation ID helper ──────────────────────────────────────────────── */

const CONV_KEY = 'claude-hackathon-conv-id';

function getOrCreateConversationId() {
  let id = localStorage.getItem(CONV_KEY);
  if (!id) {
    id = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(CONV_KEY, id);
  }
  return id;
}

/* ── Main App ────────────────────────────────────────────────────────────── */

function App() {
  const conversationId = useRef(getOrCreateConversationId()).current;

  // Fireproof for persistent storage
  const { database, useLiveQuery } = useFireproofClerk("claude-hackathon-chat");

  // Load persisted messages sorted by createdAt, scoped to this conversation
  const { docs: persistedMessages } = useLiveQuery("createdAt", {
    range: [conversationId + ":", conversationId + ":\uffff"],
  });

  // Live streaming state (for the currently-streaming assistant message)
  const [liveAssistant, setLiveAssistant] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(null); // null = loading, true/false
  const messagesEndRef = useRef(null);

  // Artifact state
  const [artifacts, setArtifacts] = useState([]);
  const [activeArtifact, setActiveArtifact] = useState('');
  const artifactRefreshRef = useRef(null);

  // Helper: get Clerk session token for authenticated API calls
  const getAuthHeaders = useCallback(async () => {
    const headers = { 'Content-Type': 'application/json' };
    try {
      const token = await window.Clerk?.session?.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } catch {}
    return headers;
  }, []);

  // Fetch artifact list
  const refreshArtifacts = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const r = await fetch('/api/artifacts', { headers });
      if (r.ok) {
        const data = await r.json();
        setArtifacts(data.files || []);
        return data.files || [];
      }
    } catch {}
    return [];
  }, [getAuthHeaders]);

  // Load artifact on auto-detect: refresh list then set active
  const loadArtifact = useCallback(async (filename) => {
    const files = await refreshArtifacts();
    if (files.some(f => f.name === filename)) {
      setActiveArtifact(filename);
    }
  }, [refreshArtifacts]);

  // Health check on mount + initial artifact fetch
  useEffect(() => {
    (async () => {
      try {
        const headers = await getAuthHeaders();
        const r = await fetch('/api/health', { headers });
        const data = await r.json();
        setConnected(data.processAlive);
        setSetupNeeded(data.needsSetup ?? false);
      } catch {
        setConnected(false);
        setSetupNeeded(false);
      }
    })();
    refreshArtifacts();
  }, [getAuthHeaders, refreshArtifacts]);

  // Periodically refresh artifact list (every 10s)
  useEffect(() => {
    const id = setInterval(refreshArtifacts, 10000);
    return () => clearInterval(id);
  }, [refreshArtifacts]);

  // Auto-scroll on new messages or live updates
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [persistedMessages, liveAssistant]);

  // Build display messages: persisted + live streaming message
  const displayMessages = React.useMemo(() => {
    const sorted = [...persistedMessages].sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });
    const msgs = sorted.map(doc => ({
      id: doc._id,
      role: doc.role,
      text: doc.text || '',
      blocks: doc.blocks || [],
      thinking: false,
      streaming: false,
    }));
    if (liveAssistant) {
      msgs.push(liveAssistant);
    }
    return msgs;
  }, [persistedMessages, liveAssistant]);

  const hasMessages = displayMessages.length > 0;

  const sendMessage = useCallback(async (text) => {
    if (streaming) return;

    // Write user message to Fireproof immediately
    const userCreatedAt = conversationId + ":" + new Date().toISOString();
    await database.put({
      type: "message",
      role: "user",
      text,
      blocks: [],
      createdAt: userCreatedAt,
      conversationId,
    });

    // Set up live assistant message for streaming
    const liveMsg = { id: 'live-' + Date.now(), role: 'assistant', blocks: [], thinking: true, streaming: true };
    setLiveAssistant(liveMsg);
    setStreaming(true);

    let finalBlocks = [];

    try {
      const headers = await getAuthHeaders();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: text }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'done') continue;

            if (data.type === 'error') {
              finalBlocks = [{ type: 'text', text: 'Error: ' + (data.data?.message || 'Unknown error') }];
              setLiveAssistant(prev => prev ? { ...prev, blocks: finalBlocks, thinking: false, streaming: false } : null);
              continue;
            }

            const eventData = data.data;
            if (!eventData) continue;
            if (eventData.type === 'system') continue;

            // Assistant message with content blocks
            if (eventData.type === 'assistant' && eventData.message?.content) {
              const blocks = eventData.message.content.map(block => {
                if (block.type === 'text') return { type: 'text', text: block.text };
                if (block.type === 'tool_use') {
                  // Auto-detect HTML artifact writes
                  if (block.name === 'Write' && block.input?.file_path) {
                    const fp = block.input.file_path;
                    const match = fp.match(/([^/]+\.html)$/);
                    if (match && match[1] !== 'index.html') {
                      // Delay slightly to let the file be written
                      setTimeout(() => loadArtifact(match[1]), 1500);
                    }
                  }
                  return { type: 'tool_use', name: block.name, input: block.input };
                }
                return block;
              });
              finalBlocks = blocks;
              setLiveAssistant(prev => prev ? { ...prev, blocks, thinking: false, streaming: true } : null);
            }

            // Final result — also check for artifacts
            if (eventData.type === 'result') {
              if (eventData.result && finalBlocks.length === 0) {
                finalBlocks = [{ type: 'text', text: eventData.result }];
              }
              setLiveAssistant(prev => prev ? { ...prev, blocks: finalBlocks, thinking: false, streaming: false } : null);
              // Refresh artifacts after turn completes
              refreshArtifacts();
            }
          } catch {}
        }
      }
    } catch (err) {
      finalBlocks = [{ type: 'text', text: 'Connection error: ' + err.message }];
      setLiveAssistant(prev => prev ? { ...prev, blocks: finalBlocks, thinking: false, streaming: false } : null);
    }

    // Persist final assistant message to Fireproof
    const assistantCreatedAt = conversationId + ":" + new Date().toISOString();
    await database.put({
      type: "message",
      role: "assistant",
      text: '',
      blocks: finalBlocks,
      createdAt: assistantCreatedAt,
      conversationId,
    });

    // Clear live message (it's now in Fireproof)
    setLiveAssistant(null);
    setStreaming(false);
    setConnected(true);
  }, [streaming, conversationId, database, getAuthHeaders, loadArtifact, refreshArtifacts]);

  const startNewConversation = useCallback(() => {
    const newId = 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(CONV_KEY, newId);
    window.location.reload();
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
        * { box-sizing: border-box; }
        body {
          margin: 0; padding: 0;
          font-family: 'Inter', -apple-system, sans-serif;
          background: #09090b;
          color: #e2e8f0;
          -webkit-font-smoothing: antialiased;
        }
        code, .font-mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes drift1 {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(40px, 30px) scale(1.1); }
        }
        @keyframes drift2 {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(-30px, -20px) scale(1.05); }
        }
        @keyframes drift3 {
          0% { transform: translate(0, 0); }
          100% { transform: translate(25px, -25px); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
        .cursor-blink::after {
          content: '|';
          animation: blink 1s step-end infinite;
          color: #6366f1;
          font-weight: 300;
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      `}</style>

      <GlowOrbs />

      {setupNeeded === null ? (
        /* ── Loading ── */
        <div className="relative min-h-screen flex items-center justify-center" style={{ zIndex: 1 }}>
          <div className="flex gap-1">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-2 h-2 rounded-full" style={{
                backgroundColor: '#6366f1',
                animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
        </div>
      ) : setupNeeded ? (
        /* ── Setup Screen ── */
        <SetupScreen
          getAuthHeaders={getAuthHeaders}
          onComplete={() => { setSetupNeeded(false); setConnected(true); }}
        />
      ) : !hasMessages ? (
        /* ── Welcome Screen ── */
        <div className="relative min-h-screen flex items-center justify-center p-6" style={{ zIndex: 1 }}>
          <div className="w-full max-w-2xl flex flex-col gap-6">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  boxShadow: '0 4px 12px rgba(99,102,241,0.3)',
                }}>
                  <span className="text-white text-sm font-bold font-mono">&gt;_</span>
                </div>
                <span className="text-xs font-mono tracking-widest" style={{ color: 'rgba(255,255,255,0.3)' }}>
                  CLAUDE HACKATHON
                </span>
                <div className="flex-1" />
                <StatusBadge ok={connected} />
              </div>
              <h1 className="text-3xl font-semibold tracking-tight mt-3" style={{ minHeight: '2.5rem' }}>
                Communication Protocol Initialized
              </h1>
            </div>

            <GlassCard>
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h2 className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>
                    Persistent Process Bridge
                  </h2>
                  <p className="text-xs mt-1 font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    stream-json // fireproof sync
                  </p>
                </div>
              </div>
              <div className="rounded-xl p-4 text-sm leading-relaxed" style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.04)',
                color: 'rgba(255,255,255,0.55)',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 13,
              }}>
                Connected to a persistent Claude process. Messages persist across refreshes via Fireproof and sync across devices.
              </div>
            </GlassCard>

            <div className="flex flex-wrap gap-2">
              <FeaturePill icon="&#9670;" label="Persistent Process" />
              <FeaturePill icon="&#9671;" label="Fireproof Sync" />
              <FeaturePill icon="&#9672;" label="SSE Streaming" />
              <FeaturePill icon="&#9673;" label="Tool Calls" />
              <FeaturePill icon="&#9674;" label="Markdown" />
            </div>

            <GlassCard className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono tracking-widest" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  SEND A MESSAGE TO BEGIN
                </span>
                <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
              </div>
              <ChatInput onSend={sendMessage} disabled={streaming} />
            </GlassCard>

            <p className="text-center text-xs" style={{ color: 'rgba(255,255,255,0.15)' }}>
              Every response arrives as a living interface.
            </p>
          </div>
        </div>
      ) : (
        /* ── Two-Column Chat + Artifact Interface ── */
        <div className="relative flex h-screen" style={{ zIndex: 1 }}>
          {/* Left column: Chat */}
          <div className="flex flex-col h-full" style={{ width: 420, minWidth: 320, flexShrink: 0 }}>
            {/* Chat header */}
            <div className="flex items-center gap-3 px-4 py-3" style={{
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(9,9,11,0.8)',
              backdropFilter: 'blur(20px)',
              minHeight: 56,
            }}>
              <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              }}>
                <span className="text-white text-[10px] font-bold font-mono">&gt;_</span>
              </div>
              <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.7)' }}>
                Julian
              </span>
              <div className="flex-1" />
              <button
                onClick={startNewConversation}
                className="rounded-lg px-2.5 py-1 text-[10px] font-medium transition-all cursor-pointer"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.4)',
                }}
              >
                New
              </button>
              <StatusBadge ok={connected} />
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {displayMessages.map(msg => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="px-4 py-3" style={{
              borderTop: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(9,9,11,0.8)',
              backdropFilter: 'blur(20px)',
            }}>
              <ChatInput onSend={sendMessage} disabled={streaming} />
            </div>
          </div>

          {/* Right column: Artifact viewer */}
          <div className="flex-1 min-w-0">
            <ArtifactViewer
              activeArtifact={activeArtifact}
              artifacts={artifacts}
              onSelect={setActiveArtifact}
              getAuthHeaders={getAuthHeaders}
            />
          </div>
        </div>
      )}
    </>
  );
}

export default App;
