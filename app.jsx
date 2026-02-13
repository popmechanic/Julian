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
    `<pre style="background:#1a1a00;border:1px solid #333;border-radius:4px;padding:8px 12px;overflow-x:auto;font-size:14px;line-height:1.5;margin:6px 0;color:#FFD600;font-family:'VT323',monospace"><code>${code.trim()}</code></pre>`
  );
  html = html.replace(/`([^`]+)`/g,
    '<code style="background:#1a1a00;padding:1px 4px;border-radius:2px;font-size:0.95em;color:#FFD600">$1</code>');
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

/* ── Pixel Face Canvas ───────────────────────────────────────────────────── */

function PixelFace({ talking, size = 120 }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ talking: false, blinking: false });
  const animRef = useRef(null);

  useEffect(() => {
    stateRef.current.talking = talking;
  }, [talking]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const ON = '#FFD600';
    const OFF = '#0F0F0F';

    const eyeLeft = [
      [8,10],[9,10],[10,10],
      [7,11],[11,11],
      [7,12],[11,12],[12,12],
      [7,13],[8,13],[12,13],
      [7,14],[12,14],
      [8,15],[9,15],[10,15],[11,15]
    ];
    const eyeRight = [
      [20,9],[21,9],[22,9],
      [19,10],[23,10],
      [19,11],[23,11],
      [19,12],[23,12],
      [19,13],[23,13],
      [20,14],[21,14],[22,14]
    ];
    const mouthIdle = [
      [6,20],
      [6,21],[7,21],
      [7,22],[8,22],
      [8,23],[9,23],[10,23],[11,23],[12,23],[13,23],[14,23],[15,23],[16,23],[17,23],
      [18,22],[19,22],
      [20,21],[21,21],
      [22,20],[23,20],[24,19]
    ];
    const mouthTalk1 = [
      [10,20],[11,20],[12,20],[13,20],[14,20],
      [9,21],[15,21],
      [9,22],[15,22],
      [9,23],[15,23],
      [10,24],[11,24],[12,24],[13,24],[14,24]
    ];
    const mouthTalk2 = [
      [11,22],[12,22],[13,22]
    ];

    function drawPixels(pixels) {
      ctx.fillStyle = ON;
      pixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
    }

    function draw() {
      ctx.fillStyle = OFF;
      ctx.fillRect(0, 0, 32, 32);
      if (!stateRef.current.blinking) {
        drawPixels(eyeLeft);
        drawPixels(eyeRight);
      }
      if (stateRef.current.talking) {
        if (Math.floor(Date.now() / 150) % 2 === 0) {
          drawPixels(mouthTalk1);
        } else {
          drawPixels(mouthTalk2);
        }
      } else {
        drawPixels(mouthIdle);
      }
      animRef.current = requestAnimationFrame(draw);
    }

    draw();

    function scheduleBlink() {
      const delay = Math.random() * 3000 + 2000;
      setTimeout(() => {
        stateRef.current.blinking = true;
        setTimeout(() => {
          stateRef.current.blinking = false;
          scheduleBlink();
        }, 150);
      }, delay);
    }
    scheduleBlink();

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={32}
      height={32}
      style={{
        width: size,
        height: size,
        imageRendering: 'pixelated',
      }}
    />
  );
}

/* ── Status indicator (retro) ─────────────────────────────────────────── */

function StatusDots({ ok }) {
  return (
    <div className="flex gap-1 items-center">
      <div style={{
        width: 8, height: 8,
        backgroundColor: ok ? '#FFD600' : '#333',
        boxShadow: ok ? '0 0 5px #FFD600' : 'none',
        animation: ok ? 'pulse-dot 2s ease-in-out infinite' : 'none',
      }} />
      <div style={{ width: 8, height: 8, backgroundColor: '#333' }} />
      <div style={{ width: 8, height: 8, backgroundColor: '#333' }} />
    </div>
  );
}

/* ── Chat components ─────────────────────────────────────────────────────── */

function ThinkingDots() {
  return (
    <div className="flex items-center gap-2" style={{ padding: '4px 0' }}>
      <span style={{ color: '#FFD600', fontSize: '1.1rem', fontFamily: "'VT323', monospace" }}>
        {'>'} PROCESSING
      </span>
      <span style={{
        color: '#FFD600',
        animation: 'blink 1s step-end infinite',
        fontFamily: "'VT323', monospace",
        fontSize: '1.1rem',
      }}>_</span>
    </div>
  );
}

function ToolCallBlock({ name, input }) {
  return (
    <div style={{
      margin: '4px 0',
      padding: '4px 0',
      borderLeft: '2px solid #AA8800',
      paddingLeft: 8,
    }}>
      <div style={{
        color: '#AA8800',
        fontSize: '0.95rem',
        fontFamily: "'VT323', monospace",
        textTransform: 'uppercase',
      }}>
        [{name}]
      </div>
      <div style={{
        color: '#666',
        fontSize: '0.9rem',
        fontFamily: "'VT323', monospace",
      }}>
        {formatToolInput(name, input)}
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  if (message.role === 'user') {
    return (
      <div style={{
        padding: '4px 0',
        fontSize: '1.1rem',
        fontFamily: "'VT323', monospace",
        color: '#fff',
        opacity: 0.8,
      }}>
        <span style={{ color: '#666' }}>{'// '}</span>
        {message.text}
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {message.thinking && <ThinkingDots />}
      {message.blocks && message.blocks.map((block, i) => {
        if (block.type === 'text') {
          return (
            <div key={i} style={{
              fontSize: '1.1rem',
              fontFamily: "'VT323', monospace",
              color: '#FFD600',
              textShadow: '0 0 2px #AA8800',
              lineHeight: 1.4,
            }}>
              <span style={{ color: '#FFD600' }}>{'> '}</span>
              <span dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }} />
            </div>
          );
        }
        if (block.type === 'tool_use') {
          return <ToolCallBlock key={i} name={block.name} input={block.input} />;
        }
        return null;
      })}
      {message.streaming && !message.thinking && (
        <span style={{
          color: '#FFD600',
          animation: 'blink 1s step-end infinite',
          fontFamily: "'VT323', monospace",
          fontSize: '1.1rem',
        }}>_</span>
      )}
    </div>
  );
}

/* ── Artifact Viewer (retro themed) ──────────────────────────────────────── */

function ArtifactViewer({ activeArtifact, artifacts, onSelect, getAuthHeaders }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

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
      background: '#0F0F0F',
      border: '4px solid #2a2a2a',
      borderRadius: 12,
      margin: 0,
      overflow: 'hidden',
      boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
      position: 'relative',
    }}>
      {/* CRT overlay on artifact panel */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.1) 50%), linear-gradient(90deg, rgba(255,0,0,0.06), rgba(0,255,0,0.02), rgba(0,0,255,0.06))',
        backgroundSize: '100% 2px, 3px 100%',
        opacity: 0.08,
        pointerEvents: 'none',
        zIndex: 20,
        borderRadius: 12,
      }} />

      {/* Artifact header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderBottom: '1px dashed #333',
        background: '#0F0F0F',
        minHeight: 50,
        position: 'relative',
        zIndex: 10,
      }}>
        <span style={{
          color: '#AA8800',
          fontSize: '0.85rem',
          fontFamily: "'VT323', monospace",
          letterSpacing: '0.15em',
        }}>
          DISPLAY://
        </span>

        {/* Dropdown selector */}
        <div style={{ position: 'relative', flex: 1 }} ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 12px',
              background: '#1a1a00',
              border: '2px solid #333',
              borderRadius: 4,
              color: activeArtifact ? '#FFD600' : '#666',
              fontFamily: "'VT323', monospace",
              fontSize: '1rem',
              textAlign: 'left',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeArtifact || 'SELECT FILE...'}
            </span>
            <span style={{ color: '#666', fontSize: 10 }}>
              {dropdownOpen ? '\u25B2' : '\u25BC'}
            </span>
          </button>

          {dropdownOpen && artifacts.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: 4,
              background: '#0F0F0F',
              border: '2px solid #333',
              borderRadius: 4,
              zIndex: 50,
              maxHeight: 300,
              overflowY: 'auto',
            }}>
              {artifacts.map(f => (
                <button
                  key={f.name}
                  onClick={() => { onSelect(f.name); setDropdownOpen(false); }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 12px',
                    fontFamily: "'VT323', monospace",
                    fontSize: '1rem',
                    color: f.name === activeArtifact ? '#FFD600' : '#AA8800',
                    background: f.name === activeArtifact ? '#1a1a00' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid #1a1a1a',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                  onMouseEnter={e => e.target.style.background = '#1a1a00'}
                  onMouseLeave={e => e.target.style.background = f.name === activeArtifact ? '#1a1a00' : 'transparent'}
                >
                  {f.name}
                  <span style={{ marginLeft: 8, color: '#444' }}>
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
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: '#E5E5E5',
              color: '#333',
              border: '1px solid #999',
              boxShadow: '0 3px 0 #999, 0 6px 8px rgba(0,0,0,0.15)',
              textDecoration: 'none',
              fontFamily: "'VT323', monospace",
              fontSize: '1rem',
              fontWeight: 700,
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'all 0.1s',
            }}
            title="OPEN IN NEW TAB"
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
          style={{
            flex: 1,
            width: '100%',
            border: 'none',
            background: '#fff',
            borderRadius: '0 0 8px 8px',
          }}
          title={activeArtifact}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        />
      ) : (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}>
          {/* Decorative pixel grid pattern */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(8, 1fr)',
            gap: 3,
            opacity: 0.15,
          }}>
            {Array.from({ length: 64 }, (_, i) => (
              <div key={i} style={{
                width: 6,
                height: 6,
                backgroundColor: (i % 7 === 0 || i % 11 === 0) ? '#FFD600' : '#333',
              }} />
            ))}
          </div>
          <div style={{
            fontFamily: "'VT323', monospace",
            fontSize: '1.2rem',
            color: '#444',
            textAlign: 'center',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}>
            {artifacts.length > 0
              ? '> SELECT ARTIFACT TO DISPLAY'
              : '> AWAITING ARTIFACT GENERATION'}
          </div>
          <div style={{
            fontFamily: "'VT323', monospace",
            fontSize: '0.9rem',
            color: '#333',
            textAlign: 'center',
          }}>
            JULIAN WILL CREATE ARTIFACTS HERE
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Setup Screen ────────────────────────────────────────────────────────── */

function SetupScreen({ onComplete, getAuthHeaders }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  const handleConnect = useCallback(async () => {
    const trimmed = token.replace(/\s+/g, '');
    if (!trimmed) return;
    if (!trimmed.startsWith('sk-ant-oat')) {
      setError('TOKEN MUST START WITH sk-ant-oat (RUN claude setup-token)');
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
        setError(data.error || 'SETUP FAILED');
        setStatus('error');
        return;
      }
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
      setError('CLAUDE PROCESS DID NOT START. CHECK SERVER LOGS.');
      setStatus('error');
    } catch (err) {
      setError('CONNECTION ERROR: ' + err.message);
      setStatus('error');
    }
  }, [token, getAuthHeaders, onComplete]);

  const isLoading = status === 'loading' || status === 'polling';

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      backgroundColor: '#FFD600',
    }}>
      <div style={{ width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ textAlign: 'center' }}>
          <PixelFace talking={false} size={100} />
          <h1 style={{
            fontFamily: "'VT323', monospace",
            fontSize: '2rem',
            color: '#FFD600',
            marginTop: 16,
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
          }}>
            CONNECT TO CLAUDE
          </h1>
          <p style={{
            fontFamily: "'VT323', monospace",
            fontSize: '1.1rem',
            color: '#AA8800',
            marginTop: 4,
          }}>
            ONE-TIME SETUP TO LINK YOUR ACCOUNT
          </p>
        </div>

        <div style={{
          background: '#0F0F0F',
          border: '4px solid #2a2a2a',
          borderRadius: 12,
          padding: 24,
          boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}>
          <div>
            <div style={{
              fontFamily: "'VT323', monospace",
              fontSize: '1.1rem',
              color: '#FFD600',
              marginBottom: 8,
            }}>
              {'>'} STEP 1: GENERATE TOKEN
            </div>
            <div style={{
              background: '#1a1a00',
              border: '1px solid #333',
              borderRadius: 4,
              padding: '8px 12px',
              fontFamily: "'VT323', monospace",
              fontSize: '1.1rem',
            }}>
              <span style={{ color: '#666' }}>$</span>{' '}
              <span style={{ color: '#FFD600' }}>claude setup-token</span>
            </div>
          </div>

          <div style={{ height: 1, background: '#333', borderStyle: 'dashed' }} />

          <div>
            <div style={{
              fontFamily: "'VT323', monospace",
              fontSize: '1.1rem',
              color: '#FFD600',
              marginBottom: 8,
            }}>
              {'>'} STEP 2: PASTE TOKEN
            </div>
            <input
              value={token}
              onChange={e => { setToken(e.target.value); setError(''); }}
              placeholder="SK-ANT-OAT01-..."
              disabled={isLoading}
              style={{
                width: '100%',
                backgroundColor: '#C8A800',
                boxShadow: 'inset 2px 2px 4px rgba(0,0,0,0.15), inset -1px -1px 2px rgba(255,255,255,0.2)',
                borderRadius: 6,
                color: '#000',
                fontWeight: 'bold',
                padding: '0 16px',
                height: 50,
                fontFamily: "'VT323', monospace",
                textTransform: 'uppercase',
                fontSize: '1.1rem',
                border: error ? '2px solid #ff4444' : '2px solid transparent',
                outline: 'none',
                opacity: isLoading ? 0.5 : 1,
                boxSizing: 'border-box',
              }}
            />
            {error && (
              <p style={{
                fontFamily: "'VT323', monospace",
                fontSize: '1rem',
                color: '#ff4444',
                marginTop: 8,
              }}>{error}</p>
            )}
          </div>

          <button
            onClick={handleConnect}
            disabled={isLoading || !token.trim()}
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: (isLoading || !token.trim()) ? '#555' : '#E5E5E5',
              color: '#333',
              border: '1px solid #999',
              boxShadow: (isLoading || !token.trim()) ? 'none' : '0 4px 0 #999, 0 8px 10px rgba(0,0,0,0.15)',
              fontFamily: "'VT323', monospace",
              fontSize: '1rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: 1,
              cursor: (isLoading || !token.trim()) ? 'default' : 'pointer',
              transition: 'all 0.1s',
              alignSelf: 'center',
            }}
          >
            {status === 'loading' ? '...' : status === 'polling' ? 'BOOT' : 'GO'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Chat input (retro) ──────────────────────────────────────────────────── */

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
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 0',
    }}>
      <input
        ref={inputRef}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
        placeholder={disabled ? "PROCESSING..." : "INPUT BUFFER..."}
        disabled={disabled}
        style={{
          flex: 1,
          backgroundColor: '#C8A800',
          boxShadow: 'inset 2px 2px 4px rgba(0,0,0,0.15), inset -1px -1px 2px rgba(255,255,255,0.2)',
          borderRadius: 6,
          color: '#000',
          fontWeight: 'bold',
          padding: '0 16px',
          height: 50,
          fontFamily: "'VT323', monospace",
          textTransform: 'uppercase',
          fontSize: '1.1rem',
          border: 'none',
          outline: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      />
      <button
        onClick={handleSend}
        disabled={disabled}
        style={{
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: disabled ? '#555' : '#E5E5E5',
          color: '#333',
          border: '1px solid #999',
          boxShadow: disabled ? 'none' : '0 4px 0 #999, 0 8px 10px rgba(0,0,0,0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'VT323', monospace",
          fontSize: '0.9rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 1,
          cursor: disabled ? 'default' : 'pointer',
          transition: 'all 0.1s',
          flexShrink: 0,
        }}
      >
        A
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

  const { database, useLiveQuery } = useFireproofClerk("claude-hackathon-chat");

  const { docs: persistedMessages } = useLiveQuery("createdAt", {
    range: [conversationId + ":", conversationId + ":\uffff"],
  });

  const [liveAssistant, setLiveAssistant] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(null);
  const messagesEndRef = useRef(null);

  const [artifacts, setArtifacts] = useState([]);
  const [activeArtifact, setActiveArtifact] = useState('');

  // Register service worker + inject PWA meta tags
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    const meta = (name, content) => {
      const el = document.createElement('meta');
      el.setAttribute('name', name);
      el.setAttribute('content', content);
      document.head.appendChild(el);
    };
    meta('theme-color', '#FFD600');
    meta('mobile-web-app-capable', 'yes');
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    meta('apple-mobile-web-app-title', 'Julian');
  }, []);

  const getAuthHeaders = useCallback(async () => {
    try {
      const token = await window.Clerk?.session?.getToken();
      if (!token) return null;
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    } catch {
      return null;
    }
  }, []);

  const refreshArtifacts = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      if (!headers) return [];
      const r = await fetch('/api/artifacts', { headers });
      if (r.ok) {
        const data = await r.json();
        setArtifacts(data.files || []);
        return data.files || [];
      }
    } catch {}
    return [];
  }, [getAuthHeaders]);

  const loadArtifact = useCallback(async (filename) => {
    const files = await refreshArtifacts();
    if (files.some(f => f.name === filename)) {
      setActiveArtifact(filename);
    }
  }, [refreshArtifacts]);

  useEffect(() => {
    let cancelled = false;
    const tryInit = async () => {
      const headers = await getAuthHeaders();
      if (!headers) {
        if (!cancelled) setTimeout(tryInit, 500);
        return;
      }
      try {
        const r = await fetch('/api/health', { headers });
        const data = await r.json();
        if (!cancelled) {
          setConnected(data.processAlive);
          setSetupNeeded(data.needsSetup ?? false);
        }
      } catch {
        if (!cancelled) {
          setConnected(false);
          setSetupNeeded(false);
        }
      }
      refreshArtifacts();
    };
    tryInit();
    return () => { cancelled = true; };
  }, [getAuthHeaders, refreshArtifacts]);

  useEffect(() => {
    const id = setInterval(refreshArtifacts, 10000);
    return () => clearInterval(id);
  }, [refreshArtifacts]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [persistedMessages, liveAssistant]);

  const displayMessages = React.useMemo(() => {
    const sorted = [...(persistedMessages || [])].sort((a, b) => {
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

    const userCreatedAt = conversationId + ":" + new Date().toISOString();
    await database.put({
      type: "message",
      role: "user",
      text,
      blocks: [],
      createdAt: userCreatedAt,
      conversationId,
    });

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

            if (eventData.type === 'assistant' && eventData.message?.content) {
              const blocks = eventData.message.content.map(block => {
                if (block.type === 'text') return { type: 'text', text: block.text };
                if (block.type === 'tool_use') {
                  if (block.name === 'Write' && block.input?.file_path) {
                    const fp = block.input.file_path;
                    const match = fp.match(/([^/]+\.html)$/);
                    if (match && match[1] !== 'index.html') {
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

            if (eventData.type === 'result') {
              if (eventData.result && finalBlocks.length === 0) {
                finalBlocks = [{ type: 'text', text: eventData.result }];
              }
              setLiveAssistant(prev => prev ? { ...prev, blocks: finalBlocks, thinking: false, streaming: false } : null);
              refreshArtifacts();
            }
          } catch {}
        }
      }
    } catch (err) {
      finalBlocks = [{ type: 'text', text: 'Connection error: ' + err.message }];
      setLiveAssistant(prev => prev ? { ...prev, blocks: finalBlocks, thinking: false, streaming: false } : null);
    }

    const assistantCreatedAt = conversationId + ":" + new Date().toISOString();
    await database.put({
      type: "message",
      role: "assistant",
      text: '',
      blocks: finalBlocks,
      createdAt: assistantCreatedAt,
      conversationId,
    });

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
        @import url('https://fonts.googleapis.com/css2?family=VT323&display=swap');
        * { box-sizing: border-box; }
        body {
          margin: 0; padding: 0;
          font-family: 'VT323', monospace;
          background-color: #FFD600;
          color: #000;
          -webkit-font-smoothing: antialiased;
        }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0F0F0F; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #FFD600; }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes pulse-dot {
          0%, 80%, 100% { opacity: 0.6; }
          40% { opacity: 1; }
        }
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
        #send-btn:active {
          transform: translateY(4px);
          box-shadow: 0 0 0 #999, inset 0 2px 5px rgba(0,0,0,0.1) !important;
        }
        input::placeholder {
          color: rgba(0,0,0,0.4);
        }
        body::before {
          content: '\u00D7';
          position: fixed;
          top: 4px;
          left: 8px;
          font-size: 28px;
          color: rgba(0,0,0,0.2);
          font-weight: 900;
          z-index: 50;
          pointer-events: none;
        }
        body::after {
          content: '\u00D7';
          position: fixed;
          top: 4px;
          right: 8px;
          font-size: 28px;
          color: rgba(0,0,0,0.2);
          font-weight: 900;
          z-index: 50;
          pointer-events: none;
        }
        /* Override HiddenMenuWrapper dark background to create yellow device frame */
        :root {
          --hm-content-bg: #FFD600 !important;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --hm-content-bg: #FFD600 !important;
          }
        }
        #container {
          background-color: #FFD600 !important;
        }
      `}</style>

      {setupNeeded === null ? (
        /* ── Loading ── */
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
          backgroundColor: '#FFD600',
        }}>
          <PixelFace talking={false} size={100} />
          <div style={{
            fontFamily: "'VT323', monospace",
            fontSize: '1.4rem',
            color: '#000',
            opacity: 0.5,
            animation: 'blink 1.5s step-end infinite',
          }}>
            BOOTING...
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
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          backgroundColor: '#FFD600',
        }}>
          <div style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Header panel */}
            <div style={{
              background: '#0F0F0F',
              border: '4px solid #2a2a2a',
              borderBottom: '1px dashed #333',
              borderRadius: '12px 12px 0 0',
              padding: 24,
              boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute',
                top: 12,
                left: 16,
                fontFamily: "'VT323', monospace",
                fontSize: '0.85rem',
                color: '#AA8800',
                letterSpacing: '0.2em',
              }}>
                SYS.VER.2.4 // ENG
              </div>
              <div style={{ position: 'absolute', top: 14, right: 16 }}>
                <StatusDots ok={connected} />
              </div>

              <PixelFace talking={false} size={140} />

              <div style={{
                fontFamily: "'VT323', monospace",
                fontSize: '0.9rem',
                color: '#AA8800',
                letterSpacing: '0.2em',
                opacity: 0.6,
                marginTop: 8,
              }}>
                STATUS: {connected ? 'ONLINE' : 'OFFLINE'}
              </div>
            </div>

            {/* Main panel */}
            <div style={{
              background: '#0F0F0F',
              border: '4px solid #2a2a2a',
              borderTop: 'none',
              borderRadius: '0 0 12px 12px',
              padding: 24,
              boxShadow: 'inset 0 -2px 10px rgba(0,0,0,0.5)',
            }}>
              <div style={{
                fontFamily: "'VT323', monospace",
                fontSize: '1.2rem',
                color: '#FFD600',
                textShadow: '0 0 2px #AA8800',
                marginBottom: 16,
              }}>
                {'>'} BOOT_SEQUENCE_COMPLETE
              </div>
              <div style={{
                fontFamily: "'VT323', monospace",
                fontSize: '1.1rem',
                color: '#FFD600',
                textShadow: '0 0 2px #AA8800',
                lineHeight: 1.5,
                marginBottom: 20,
              }}>
                {'>'} HELLO. I AM JULIAN, YOUR PERSISTENT COMPANION. USE THE INPUT BUFFER BELOW TO BEGIN.
              </div>

              <div style={{
                fontFamily: "'VT323', monospace",
                fontSize: '0.9rem',
                color: '#444',
                display: 'flex',
                gap: 16,
                flexWrap: 'wrap',
                marginBottom: 16,
              }}>
                <span>[PERSISTENT PROCESS]</span>
                <span>[FIREPROOF SYNC]</span>
                <span>[SSE STREAMING]</span>
                <span>[TOOL CALLS]</span>
              </div>

              <ChatInput onSend={sendMessage} disabled={streaming} />
            </div>
          </div>
        </div>
      ) : (
        /* ── Two-Column Chat + Artifact Interface ── */
        <div style={{
          display: 'flex',
          height: '100vh',
          padding: 16,
          gap: 16,
          backgroundColor: '#FFD600',
        }}>
          {/* Left column: Chat sidebar */}
          <div style={{
            width: 420,
            minWidth: 320,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
          }}>
            {/* Face header */}
            <div style={{
              background: '#0F0F0F',
              border: '4px solid #2a2a2a',
              borderBottom: '1px dashed #333',
              borderRadius: '12px 12px 0 0',
              padding: '12px 16px',
              boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              position: 'relative',
            }}>
              <div style={{ position: 'absolute', top: 8, left: 12 }}>
                <span style={{
                  fontFamily: "'VT323', monospace",
                  fontSize: '0.75rem',
                  color: '#AA8800',
                  letterSpacing: '0.2em',
                }}>SYS.VER.2.4</span>
              </div>
              <div style={{ position: 'absolute', top: 10, right: 12 }}>
                <StatusDots ok={connected} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, width: '100%' }}>
                <PixelFace talking={streaming} size={56} />
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: "'VT323', monospace",
                    fontSize: '1.4rem',
                    color: '#FFD600',
                    letterSpacing: '0.05em',
                  }}>
                    JULIAN
                  </div>
                  <div style={{
                    fontFamily: "'VT323', monospace",
                    fontSize: '0.85rem',
                    color: '#AA8800',
                    opacity: 0.6,
                  }}>
                    {streaming ? 'PROCESSING...' : 'LISTENING'}
                  </div>
                </div>
                <button
                  onClick={startNewConversation}
                  style={{
                    fontFamily: "'VT323', monospace",
                    fontSize: '0.85rem',
                    color: '#AA8800',
                    background: '#1a1a00',
                    border: '1px solid #333',
                    borderRadius: 4,
                    padding: '4px 10px',
                    cursor: 'pointer',
                    textTransform: 'uppercase',
                  }}
                >
                  NEW
                </button>
              </div>
            </div>

            {/* CRT overlay for chat area */}
            <div style={{
              flex: 1,
              background: '#0F0F0F',
              border: '4px solid #2a2a2a',
              borderTop: 'none',
              borderBottom: 'none',
              overflowY: 'auto',
              padding: 16,
              position: 'relative',
            }}>
              {/* CRT scanlines */}
              <div style={{
                position: 'absolute',
                inset: 0,
                background: 'linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.1) 50%), linear-gradient(90deg, rgba(255,0,0,0.06), rgba(0,255,0,0.02), rgba(0,0,255,0.06))',
                backgroundSize: '100% 2px, 3px 100%',
                opacity: 0.1,
                pointerEvents: 'none',
                zIndex: 5,
              }} />
              <div style={{ position: 'relative', zIndex: 1 }}>
                {displayMessages.map(msg => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input footer */}
            <div style={{
              background: '#0F0F0F',
              border: '4px solid #2a2a2a',
              borderTop: '1px dashed #333',
              borderRadius: '0 0 12px 12px',
              padding: '0 16px',
              boxShadow: 'inset 0 -2px 10px rgba(0,0,0,0.5)',
            }}>
              <ChatInput onSend={sendMessage} disabled={streaming} />
            </div>
          </div>

          {/* Right column: Artifact viewer */}
          <div style={{ flex: 1, minWidth: 0 }}>
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
