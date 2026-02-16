      // === Shared Error Components ===
      function ConfigError({ message }) {
        // Use AuthScreen if available, fallback to simple div
        if (window.AuthScreen) {
          return React.createElement(window.AuthScreen, {
            title: 'Configuration Error',
            message: message,
            showCard: false,
            isError: true,
            errorDetails: 'Run Connect setup to configure Clerk credentials.'
          },
            React.createElement('p', { style: { color: '#7f1d1d', fontSize: '0.875rem' } },
              'Check your .env file for missing credentials.'
            )
          );
        }
        // Fallback for when AuthScreen hasn't loaded
        return React.createElement('div', { className: 'min-h-screen flex items-center justify-center bg-gray-50' },
          React.createElement('div', { className: 'text-center p-8 bg-white rounded-xl shadow-lg max-w-md border border-red-200' },
            React.createElement('div', { className: 'text-red-500 text-4xl mb-4' }, '⚠️'),
            React.createElement('h1', { className: 'text-xl font-bold text-red-700 mb-4' }, 'Configuration Error'),
            React.createElement('p', { className: 'text-gray-600 mb-4' }, message),
            React.createElement('p', { className: 'text-sm text-gray-500' }, 'Run Connect setup to configure Clerk credentials.')
          )
        );
      }
      window.ConfigError = ConfigError;

      function LoadingError({ error }) {
        // Use AuthScreen if available, fallback to simple div
        if (window.AuthScreen) {
          return React.createElement(window.AuthScreen, {
            title: 'Loading Failed',
            message: 'Failed to load authentication components. Check your network connection and try refreshing the page.',
            showCard: false,
            isError: true,
            errorDetails: error
          },
            React.createElement('button', {
              onClick: function() { window.location.reload(); },
              style: {
                padding: '0.75rem 1.5rem',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: '500'
              }
            }, 'Retry')
          );
        }
        // Fallback for when AuthScreen hasn't loaded
        return React.createElement('div', { className: 'min-h-screen flex items-center justify-center bg-gray-50' },
          React.createElement('div', { className: 'text-center p-8 bg-white rounded-xl shadow-lg max-w-md border border-amber-200' },
            React.createElement('div', { className: 'text-amber-500 text-4xl mb-4' }, '⚡'),
            React.createElement('h1', { className: 'text-xl font-bold text-amber-700 mb-4' }, 'Loading Failed'),
            React.createElement('p', { className: 'text-gray-600 mb-4' }, 'Failed to load authentication components.'),
            React.createElement('p', { className: 'text-sm text-gray-500 mb-4' }, 'Check your network connection and try refreshing the page.'),
            React.createElement('details', { className: 'text-left text-xs text-gray-400' },
              React.createElement('summary', { className: 'cursor-pointer' }, 'Technical details'),
              React.createElement('pre', { className: 'mt-2 p-2 bg-gray-100 rounded overflow-auto' }, error)
            )
          )
        );
      }
      window.LoadingError = LoadingError;

      // === VibesPanel Event Handler Hook ===
      function useVibesPanelEvents(logPrefix) {
        React.useEffect(() => {
          const handleLogout = () => {
            if (window.Clerk) window.Clerk.signOut();
          };
          const handleSyncDisable = () => {
            console.log('[' + logPrefix + '] Sync disabled');
          };
          const handleShareRequest = (e) => {
            const { email, role, right, token } = e.detail;
            console.log('[' + logPrefix + '] Share request:', { email, role, right });
            // TODO: Implement actual share logic with Fireproof
            // For now, simulate success after a delay
            setTimeout(() => {
              document.dispatchEvent(new CustomEvent('vibes-share-success', {
                detail: { email: email, message: 'Invitation sent to ' + email + '!' }
              }));
            }, 1000);
          };

          document.addEventListener('vibes-logout-request', handleLogout);
          document.addEventListener('vibes-sync-disable', handleSyncDisable);
          document.addEventListener('vibes-share-request', handleShareRequest);
          return () => {
            document.removeEventListener('vibes-logout-request', handleLogout);
            document.removeEventListener('vibes-sync-disable', handleSyncDisable);
            document.removeEventListener('vibes-share-request', handleShareRequest);
          };
        }, []);
      }
      window.useVibesPanelEvents = useVibesPanelEvents;

/* ── React hooks destructured from window.React for bare-name usage ──── */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

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

/* ── Pixel Face Sprite Data ──────────────────────────────────────────────── */

const EYE_VARIANTS = {
  standard: {
    left: [
      [8,10],[9,10],[10,10],
      [7,11],[11,11],
      [7,12],[11,12],[12,12],
      [7,13],[8,13],[12,13],
      [7,14],[12,14],
      [8,15],[9,15],[10,15],[11,15]
    ],
    right: [
      [20,9],[21,9],[22,9],
      [19,10],[23,10],
      [19,11],[23,11],
      [19,12],[23,12],
      [19,13],[23,13],
      [20,14],[21,14],[22,14]
    ],
  },
  round: {
    left: [
      [8,10],[9,10],[10,10],
      [7,11],[11,11],
      [7,12],[8,12],[11,12],[12,12],
      [7,13],[8,13],[11,13],[12,13],
      [7,14],[12,14],
      [8,15],[9,15],[10,15],[11,15]
    ],
    right: [
      [20,9],[21,9],[22,9],
      [19,10],[23,10],
      [19,11],[20,11],[23,11],
      [19,12],[20,12],[23,12],
      [19,13],[23,13],
      [20,14],[21,14],[22,14]
    ],
  },
  narrow: {
    left: [
      [9,10],[10,10],
      [8,11],[11,11],
      [8,12],[11,12],
      [8,13],[11,13],
      [8,14],[11,14],
      [9,15],[10,15]
    ],
    right: [
      [21,9],[22,9],
      [20,10],[23,10],
      [20,11],[23,11],
      [20,12],[23,12],
      [20,13],[23,13],
      [21,14],[22,14]
    ],
  },
  wide: {
    left: [
      [7,10],[8,10],[9,10],[10,10],[11,10],
      [6,11],[12,11],
      [6,12],[12,12],
      [6,13],[12,13],
      [7,14],[8,14],[9,14],[10,14],[11,14]
    ],
    right: [
      [19,9],[20,9],[21,9],[22,9],[23,9],
      [18,10],[24,10],
      [18,11],[24,11],
      [18,12],[24,12],
      [19,13],[20,13],[21,13],[22,13],[23,13]
    ],
  },
};

const MOUTH_VARIANTS = {
  gentle: {
    idle: [
      [6,20],
      [6,21],[7,21],
      [7,22],[8,22],
      [8,23],[9,23],[10,23],[11,23],[12,23],[13,23],[14,23],[15,23],[16,23],[17,23],
      [18,22],[19,22],
      [20,21],[21,21],
      [22,20],[23,20],[24,19]
    ],
    talk1: [
      [10,20],[11,20],[12,20],[13,20],[14,20],
      [9,21],[15,21],
      [9,22],[15,22],
      [9,23],[15,23],
      [10,24],[11,24],[12,24],[13,24],[14,24]
    ],
    talk2: [
      [11,22],[12,22],[13,22]
    ],
  },
  straight: {
    idle: [
      [7,21],[8,21],[9,21],[10,21],[11,21],[12,21],[13,21],[14,21],[15,21],[16,21],[17,21],[18,21],[19,21],[20,21],[21,21],[22,21],[23,21]
    ],
    talk1: [
      [10,20],[11,20],[12,20],[13,20],[14,20],
      [9,21],[15,21],
      [9,22],[15,22],
      [10,23],[11,23],[12,23],[13,23],[14,23]
    ],
    talk2: [
      [11,21],[12,21],[13,21]
    ],
  },
  cheerful: {
    idle: [
      [24,19],[23,19],
      [22,20],[21,20],
      [20,21],[19,21],
      [18,22],[17,22],[16,22],[15,22],[14,22],[13,22],[12,22],[11,22],[10,22],[9,22],[8,22],
      [7,21],[6,21],
      [5,20],[4,20],
      [3,19]
    ],
    talk1: [
      [10,20],[11,20],[12,20],[13,20],[14,20],
      [9,21],[15,21],
      [9,22],[15,22],
      [9,23],[15,23],
      [10,24],[11,24],[12,24],[13,24],[14,24]
    ],
    talk2: [
      [11,22],[12,22],[13,22]
    ],
  },
  asymmetric: {
    idle: [
      [6,21],[7,21],
      [7,22],[8,22],
      [8,23],[9,23],[10,23],[11,23],[12,23],[13,23],[14,23],[15,23],[16,23],[17,23],
      [18,22],[19,22],
      [20,21],[21,21],
      [22,20],[23,20],
      [24,19],[25,18]
    ],
    talk1: [
      [10,20],[11,20],[12,20],[13,20],[14,20],
      [9,21],[15,21],
      [9,22],[15,22],
      [9,23],[15,23],
      [10,24],[11,24],[12,24],[13,24],[14,24]
    ],
    talk2: [
      [11,22],[12,22],[13,22]
    ],
  },
};

const GENDER_MARKERS = {
  woman: [
    [6,10],[6,9],
    [13,9],[13,8],
    [18,8],[18,9],
    [24,9],[24,8],
  ],
  man: [
    [7,8],[8,8],[9,8],[10,8],[11,8],[12,8],
    [19,7],[20,7],[21,7],[22,7],[23,7],
  ],
};

const AGENT_COLORS = [
  { name: 'Violet Heaven',    hex: '#c9b1e8', gender: 'woman' },
  { name: 'Ayahuasca Vine',   hex: '#755d00', gender: 'man' },
  { name: 'Aquarius',         hex: '#00afd1', gender: 'woman' },
  { name: 'Pacific Pleasure', hex: '#007e98', gender: 'man' },
  { name: 'Barbiecore',       hex: '#c85cb4', gender: 'woman' },
  { name: 'Pink Punk',        hex: '#da89c9', gender: 'man' },
  { name: 'Salt Air',         hex: '#B8DDE6', gender: 'woman' },
  { name: 'Cloud Coral',      hex: '#F2C4B0', gender: 'man' },
];

const EYE_KEYS = Object.keys(EYE_VARIANTS);
const MOUTH_KEYS = Object.keys(MOUTH_VARIANTS);

function hashNameToFaceVariant(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  hash = Math.abs(hash);
  return {
    eyes: EYE_KEYS[hash % EYE_KEYS.length],
    mouth: MOUTH_KEYS[(hash >> 4) % MOUTH_KEYS.length],
  };
}

/* ── Pixel Face Canvas ───────────────────────────────────────────────────── */

function PixelFace({ talking, size = 120, color = '#FFD600', eyes = 'standard', mouth = 'gentle', gender = null }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ talking: false, blinking: false });
  const animRef = useRef(null);
  const drawRef = useRef(null);

  useEffect(() => {
    stateRef.current.talking = talking;
    // Kick the animation loop when talking state changes
    if (drawRef.current && !animRef.current) {
      animRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [talking]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const ON = color;
    const OFF = '#0F0F0F';

    const eyeVariant = EYE_VARIANTS[eyes] || EYE_VARIANTS.standard;
    const mouthVariant = MOUTH_VARIANTS[mouth] || MOUTH_VARIANTS.gentle;
    const genderPixels = gender ? (GENDER_MARKERS[gender] || []) : [];

    function drawPixels(pixels) {
      ctx.fillStyle = ON;
      pixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
    }

    function draw() {
      ctx.fillStyle = OFF;
      ctx.fillRect(0, 0, 32, 32);
      if (!stateRef.current.blinking) {
        drawPixels(eyeVariant.left);
        drawPixels(eyeVariant.right);
        if (genderPixels.length) drawPixels(genderPixels);
      }
      if (stateRef.current.talking) {
        if (Math.floor(Date.now() / 150) % 2 === 0) {
          drawPixels(mouthVariant.talk1);
        } else {
          drawPixels(mouthVariant.talk2);
        }
      } else {
        drawPixels(mouthVariant.idle);
      }
      // Only keep looping when animating (talking or blinking)
      if (stateRef.current.talking || stateRef.current.blinking) {
        animRef.current = requestAnimationFrame(draw);
      } else {
        animRef.current = null;
      }
    }
    drawRef.current = draw;

    draw();

    let blinkTimeout;
    function scheduleBlink() {
      const delay = Math.random() * 3000 + 2000;
      blinkTimeout = setTimeout(() => {
        stateRef.current.blinking = true;
        // Kick animation loop for blink
        if (!animRef.current) animRef.current = requestAnimationFrame(draw);
        blinkTimeout = setTimeout(() => {
          stateRef.current.blinking = false;
          // One more frame to render eyes-open, then loop stops
          if (!animRef.current) animRef.current = requestAnimationFrame(draw);
          scheduleBlink();
        }, 150);
      }, delay);
    }
    scheduleBlink();

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      animRef.current = null;
      clearTimeout(blinkTimeout);
    };
  }, [color, eyes, mouth, gender]);

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

/* ── Egg Hatching Animation ──────────────────────────────────────────────── */

function EggHatch({ color = '#FFD600', size = 48, onComplete }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const startRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const OFF = '#0F0F0F';
    const CRACK = '#FFFFFF';

    const eggPixels = [
      [13,6],[14,6],[15,6],[16,6],[17,6],[18,6],
      [11,7],[12,7],[13,7],[14,7],[15,7],[16,7],[17,7],[18,7],[19,7],[20,7],
      [10,8],[11,8],[12,8],[19,8],[20,8],[21,8],
      [9,9],[10,9],[21,9],[22,9],
      [9,10],[22,10],
      [8,11],[23,11],
      [8,12],[23,12],
      [8,13],[23,13],
      [8,14],[23,14],
      [8,15],[23,15],
      [8,16],[23,16],
      [8,17],[23,17],
      [9,18],[22,18],
      [9,19],[22,19],
      [10,20],[21,20],
      [10,21],[21,21],
      [11,22],[12,22],[19,22],[20,22],
      [12,23],[13,23],[14,23],[15,23],[16,23],[17,23],[18,23],[19,23],
      [14,24],[15,24],[16,24],[17,24],
    ];

    const crackPixels = [
      [15,12],[16,13],[14,14],[15,15],[17,16],[16,17],[14,18],
    ];

    const APPEAR = 400, STILL = 600, WOBBLE = 800, CRACK_T = 400, SPLIT = 300, REVEAL = 500;
    const TOTAL = APPEAR + STILL + WOBBLE + CRACK_T + SPLIT + REVEAL;

    function draw(ts) {
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;

      ctx.fillStyle = OFF;
      ctx.fillRect(0, 0, 32, 32);

      if (elapsed < APPEAR) {
        const alpha = elapsed / APPEAR;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        eggPixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
        ctx.globalAlpha = 1;
      } else if (elapsed < APPEAR + STILL) {
        ctx.fillStyle = color;
        eggPixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
      } else if (elapsed < APPEAR + STILL + WOBBLE) {
        const wobbleT = elapsed - APPEAR - STILL;
        const offset = Math.round(Math.sin(wobbleT / 250 * Math.PI * 2) * 1);
        ctx.fillStyle = color;
        eggPixels.forEach(([x, y]) => ctx.fillRect(x + offset, y, 1, 1));
      } else if (elapsed < APPEAR + STILL + WOBBLE + CRACK_T) {
        ctx.fillStyle = color;
        eggPixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
        ctx.fillStyle = CRACK;
        crackPixels.forEach(([x, y]) => ctx.fillRect(x, y, 1, 1));
      } else if (elapsed < APPEAR + STILL + WOBBLE + CRACK_T + SPLIT) {
        const splitT = elapsed - APPEAR - STILL - WOBBLE - CRACK_T;
        const gap = Math.round((splitT / SPLIT) * 3);
        ctx.fillStyle = color;
        eggPixels.forEach(([x, y]) => {
          const dy = y < 15 ? -gap : gap;
          ctx.fillRect(x, y + dy, 1, 1);
        });
      } else if (elapsed < TOTAL) {
        const revealT = (elapsed - APPEAR - STILL - WOBBLE - CRACK_T - SPLIT) / REVEAL;
        const sparkleCount = Math.floor(revealT * 12);
        ctx.fillStyle = color;
        for (let i = 0; i < sparkleCount; i++) {
          const sx = 8 + ((i * 7 + 3) % 16);
          const sy = 8 + ((i * 11 + 5) % 16);
          ctx.fillRect(sx, sy, 1, 1);
        }
      } else {
        if (onComplete) onComplete();
        return;
      }

      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [color, onComplete]);

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

/* ── Agent Grid (3x3) ───────────────────────────────────────────────────── */

const JULIAN_POSITION = 4;
const AGENT_POSITIONS = [0, 1, 2, 3, 5, 6, 7, 8];

function AgentGrid({ agents = [], activeAgent = null, onSelectAgent, onSummon, summoning = false }) {
  const cells = Array.from({ length: 9 }, (_, i) => {
    if (i === JULIAN_POSITION) {
      return { type: 'julian' };
    }
    const agent = agents.find(a => a.gridPosition === i);
    if (agent) {
      if (agent.hatching) return { type: 'hatching', agent };
      if (agent.dormant) return { type: 'dormant', agent };
      return { type: 'active', agent };
    }
    return { type: 'empty' };
  });

  const hasEmptySlots = cells.some(c => c.type === 'empty');

  return (
    <div style={{ padding: '8px 4px' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 4,
      }}>
        {cells.map((cell, i) => {
          const isSelected = cell.agent && activeAgent === cell.agent.name;
          const isJulianSelected = i === JULIAN_POSITION && activeAgent === null;

          let borderColor = '#444';
          let opacity = 1;
          let content = null;
          let clickHandler = null;
          let nameLabel = null;

          if (cell.type === 'julian') {
            borderColor = '#FFD600';
            content = <PixelFace talking={false} size={32} />;
            nameLabel = 'JULIAN';
            clickHandler = () => onSelectAgent(null);
          } else if (cell.type === 'hatching') {
            borderColor = cell.agent.color;
            content = <EggHatch color={cell.agent.color} size={32} />;
          } else if (cell.type === 'active') {
            const variant = cell.agent.faceVariant || hashNameToFaceVariant(cell.agent.name);
            borderColor = cell.agent.color;
            content = (
              <PixelFace
                talking={false}
                size={32}
                color={cell.agent.color}
                eyes={variant.eyes}
                mouth={variant.mouth}
                gender={cell.agent.gender}
              />
            );
            nameLabel = cell.agent.name.toUpperCase().slice(0, 7);
            clickHandler = () => onSelectAgent(cell.agent.name);
          } else if (cell.type === 'dormant') {
            const variant = cell.agent.faceVariant || hashNameToFaceVariant(cell.agent.name);
            borderColor = cell.agent.color;
            opacity = 0.4;
            content = (
              <PixelFace
                talking={false}
                size={32}
                color={cell.agent.color}
                eyes={variant.eyes}
                mouth={variant.mouth}
                gender={cell.agent.gender}
              />
            );
            nameLabel = cell.agent.name.toUpperCase().slice(0, 7);
            clickHandler = () => onSelectAgent(cell.agent.name);
          }

          return (
            <div
              key={i}
              onClick={clickHandler}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                padding: 4,
                border: `${(isSelected || isJulianSelected) ? 2 : 1}px solid ${borderColor}`,
                borderRadius: 4,
                background: '#0a0a0a',
                opacity,
                cursor: clickHandler ? 'pointer' : 'default',
                minHeight: 52,
                transition: 'border 0.15s, opacity 0.15s',
              }}
            >
              {content}
              {nameLabel && (
                <div style={{
                  fontFamily: "'VT323', monospace",
                  fontSize: '0.55rem',
                  color: cell.type === 'julian' ? '#FFD600' : (cell.agent?.color || '#666'),
                  letterSpacing: '0.05em',
                  textAlign: 'center',
                  lineHeight: 1,
                  marginTop: 1,
                }}>
                  {nameLabel}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hasEmptySlots && (
        <button
          onClick={onSummon}
          disabled={summoning}
          style={{
            width: '100%',
            marginTop: 6,
            padding: '6px 0',
            fontFamily: "'VT323', monospace",
            fontSize: '0.85rem',
            color: summoning ? '#666' : '#FFD600',
            background: summoning ? '#1a1a1a' : '#1a1a00',
            border: `1px solid ${summoning ? '#333' : '#FFD600'}`,
            borderRadius: 4,
            cursor: summoning ? 'default' : 'pointer',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
          }}
        >
          {summoning ? 'SUMMONING...' : 'SUMMON'}
        </button>
      )}
    </div>
  );
}

/* ── Agent Face Header ──────────────────────────────────────────────────── */

function AgentFaceHeader({ agent, talking, onBack }) {
  const variant = agent.faceVariant || hashNameToFaceVariant(agent.name);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, width: '100%' }}>
      <PixelFace
        talking={talking}
        size={56}
        color={agent.color}
        eyes={variant.eyes}
        mouth={variant.mouth}
        gender={agent.gender}
      />
      <div style={{ flex: 1 }}>
        <div style={{
          fontFamily: "'VT323', monospace",
          fontSize: '1.4rem',
          color: agent.color,
          letterSpacing: '0.05em',
        }}>
          {agent.name.toUpperCase()}
        </div>
        <div style={{
          fontFamily: "'VT323', monospace",
          fontSize: '0.85rem',
          color: agent.color,
          opacity: 0.6,
        }}>
          {talking ? 'PROCESSING...' : 'LISTENING'}
        </div>
      </div>
      <button
        onClick={onBack}
        style={{
          fontFamily: "'VT323', monospace",
          fontSize: '0.75rem',
          color: '#AA8800',
          background: '#1a1a00',
          border: '1px solid #333',
          borderRadius: 4,
          padding: '4px 8px',
          cursor: 'pointer',
          letterSpacing: '0.05em',
        }}
      >
        JULIAN
      </button>
    </div>
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

/* ── JulianScreen Embed ──────────────────────────────────────────────────── */

function JulianScreenEmbed({ sessionActive, compact, onFileSelect }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const reconnectDelayRef = useRef(2000);
  const onFileSelectRef = useRef(onFileSelect);
  const [connected, setConnected] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => { onFileSelectRef.current = onFileSelect; }, [onFileSelect]);

  // Initialize JulianScreen on canvas mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !window.JScreen) return;
    window.JScreen.init(canvas);
    if (window.JScreen.initInput) {
      window.JScreen.initInput(canvas);
    }
  }, []);

  // WebSocket connection + feedback handler
  useEffect(() => {
    async function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl;
      if (location.hostname === 'localhost') {
        wsUrl = 'ws://localhost:3848/ws';
      } else {
        wsUrl = `${proto}//${location.host}/screen/ws`;
      }
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        reconnectDelayRef.current = 2000;
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current);
          reconnectRef.current = null;
        }
        // Set up sendFeedback to intercept FILE_SELECT locally
        if (window.JScreen) {
          window.JScreen.sendFeedback = function(event) {
            // Handle FILE_SELECT in the browser tab — open in artifact viewer
            if (event.type === 'FILE_SELECT' && event.tab === 'browser') {
              const filename = event.file;
              const artifactUrl = '/api/artifacts/' + encodeURIComponent(filename);
              // Dispatch custom event for parent App to handle
              document.dispatchEvent(new CustomEvent('julian-file-select', {
                detail: { filename, url: artifactUrl }
              }));
              // Also call callback prop if provided
              if (onFileSelectRef.current) onFileSelectRef.current(filename, artifactUrl);
            }
            // Forward all events to server for agent consumption
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          };
        }
      };

      ws.onmessage = (event) => {
        if (!window.JScreen) return;
        try {
          const data = JSON.parse(event.data);
          if (Array.isArray(data)) {
            const cmds = data.filter(c => c.type !== 'READY');
            if (cmds.length > 0) window.JScreen.enqueueCommands(cmds);
          } else if (data.type && data.type !== 'READY') {
            window.JScreen.enqueueCommands([data]);
          }
        } catch {}
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (!reconnectRef.current) {
          reconnectRef.current = setTimeout(() => {
            reconnectRef.current = null;
            connect();
          }, reconnectDelayRef.current);
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 30000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();
    return () => {
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, []);

  // Exit menu when a session becomes active
  useEffect(() => {
    if (connected && sessionActive && window.JScreen?.exitMenu && window.JScreen.isMenuActive?.()) {
      window.JScreen.exitMenu();
    }
  }, [connected, sessionActive]);

  // Resize handler: integer-scale the canvas
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    function updateScale() {
      const rect = container.getBoundingClientRect();
      const sx = Math.floor(rect.width / 128);
      const sy = Math.floor(rect.height / 96);
      const s = Math.max(1, Math.min(sx, sy));
      setScale(s);
      canvas.style.width = (128 * s) + 'px';
      canvas.style.height = (96 * s) + 'px';
      if (window.JScreen) window.JScreen._scale = s;
    }

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div style={{
      position: 'relative',
      aspectRatio: '4/3',
      maxWidth: '100%',
      maxHeight: '100%',
      width: '100%',
      background: '#0a0a0a',
      border: '4px solid #2a2a2a',
      borderRadius: 12,
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }} ref={containerRef}>
      {/* CRT scanline overlay */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'linear-gradient(rgba(18,16,16,0) 50%, rgba(0,0,0,0.1) 50%), linear-gradient(90deg, rgba(255,0,0,0.06), rgba(0,255,0,0.02), rgba(0,0,255,0.06))',
        backgroundSize: '100% 2px, 3px 100%',
        opacity: 0.08,
        pointerEvents: 'none',
        zIndex: 10,
        borderRadius: 12,
      }} />

      {/* Connection status dot */}
      <div style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: connected ? '#FFD600' : '#444',
        boxShadow: connected ? '0 0 6px #FFD600' : 'none',
        zIndex: 20,
      }} />

      <canvas
        ref={canvasRef}
        id="screen"
        width={128}
        height={96}
        style={{
          imageRendering: 'pixelated',
          width: 128 * scale,
          height: 96 * scale,
        }}
      />
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

/* ── Setup Screen (tabbed: OAuth-first / legacy fallback) ────────────────── */

function SetupScreen({ onComplete, getAuthHeaders }) {
  const [tab, setTab] = useState('oauth'); // 'oauth' | 'legacy'

  // OAuth state
  const [oauthStep, setOauthStep] = useState(1); // 1 = click button, 2 = paste code
  const [oauthState, setOauthState] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [oauthStatus, setOauthStatus] = useState('idle');
  const [oauthError, setOauthError] = useState('');

  // Legacy state
  const [token, setToken] = useState('');
  const [legacyStatus, setLegacyStatus] = useState('idle');
  const [legacyError, setLegacyError] = useState('');

  // Poll health until process is alive
  const pollUntilAlive = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const h = await getAuthHeaders();
        const hr = await fetch('/api/health', { headers: h });
        if (!hr.ok) continue;
        const hd = await hr.json();
        if (!hd.needsSetup) {
          onComplete();
          return true;
        }
      } catch {}
    }
    return false;
  }, [getAuthHeaders, onComplete]);

  // OAuth: start flow — open window synchronously to avoid popup blocker
  const handleOAuthStart = useCallback(async () => {
    setOauthStatus('starting');
    setOauthError('');
    const popup = window.open('about:blank', '_blank');
    try {
      const headers = await getAuthHeaders();
      if (!headers) { if (popup) popup.close(); setOauthError('NOT AUTHENTICATED. RELOAD PAGE.'); setOauthStatus('error'); return; }
      const res = await fetch('/api/oauth/start', { headers });
      const data = await res.json();
      if (!res.ok) {
        if (popup) popup.close();
        setOauthError(data.error || 'FAILED TO START OAUTH');
        setOauthStatus('error');
        return;
      }
      setOauthState(data.state);
      if (popup) popup.location.href = data.authUrl;
      else window.open(data.authUrl, '_blank', 'noopener');
      setOauthStep(2);
      setOauthStatus('idle');
    } catch (err) {
      if (popup) popup.close();
      setOauthError('CONNECTION ERROR: ' + err.message);
      setOauthStatus('error');
    }
  }, [getAuthHeaders]);

  // OAuth: exchange code
  const handleOAuthExchange = useCallback(async () => {
    const code = oauthCode.trim();
    if (!code || !oauthState) return;
    setOauthStatus('exchanging');
    setOauthError('');
    try {
      const headers = await getAuthHeaders();
      if (!headers) { setOauthError('NOT AUTHENTICATED. RELOAD PAGE.'); setOauthStatus('error'); return; }
      const res = await fetch('/api/oauth/exchange', {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, state: oauthState }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error?.includes('expired state') || data.error?.includes('Invalid or expired')) {
          setOauthStep(1);
          setOauthCode('');
          setOauthError('SESSION EXPIRED. PLEASE START OVER.');
          setOauthStatus('idle');
        } else {
          setOauthError(data.error || 'TOKEN EXCHANGE FAILED');
          setOauthStatus('error');
        }
        return;
      }
      setOauthStatus('polling');
      const alive = await pollUntilAlive();
      if (!alive) {
        setOauthError('CLAUDE PROCESS DID NOT START. CHECK SERVER LOGS.');
        setOauthStatus('error');
      }
    } catch (err) {
      setOauthError('CONNECTION ERROR: ' + err.message);
      setOauthStatus('error');
    }
  }, [oauthCode, oauthState, getAuthHeaders, pollUntilAlive]);

  // Legacy: paste token
  const handleLegacyConnect = useCallback(async () => {
    const trimmed = token.replace(/\s+/g, '');
    if (!trimmed) return;
    if (!trimmed.startsWith('sk-ant-oat')) {
      setLegacyError('TOKEN MUST START WITH sk-ant-oat (RUN claude setup-token)');
      return;
    }
    setLegacyStatus('loading');
    setLegacyError('');
    try {
      const headers = await getAuthHeaders();
      if (!headers) { setLegacyError('NOT AUTHENTICATED. RELOAD PAGE.'); setLegacyStatus('error'); return; }
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLegacyError(data.error || 'SETUP FAILED');
        setLegacyStatus('error');
        return;
      }
      setLegacyStatus('polling');
      const alive = await pollUntilAlive();
      if (!alive) {
        setLegacyError('CLAUDE PROCESS DID NOT START. CHECK SERVER LOGS.');
        setLegacyStatus('error');
      }
    } catch (err) {
      setLegacyError('CONNECTION ERROR: ' + err.message);
      setLegacyStatus('error');
    }
  }, [token, getAuthHeaders, pollUntilAlive]);

  const oauthLoading = oauthStatus === 'starting' || oauthStatus === 'exchanging' || oauthStatus === 'polling';
  const legacyLoading = legacyStatus === 'loading' || legacyStatus === 'polling';

  const tabStyle = (active) => ({
    flex: 1,
    padding: '10px 0',
    fontFamily: "'VT323', monospace",
    fontSize: '1.1rem',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    cursor: 'pointer',
    border: 'none',
    borderBottom: active ? '2px solid #FFD600' : '2px solid transparent',
    background: 'transparent',
    color: active ? '#FFD600' : '#666',
    transition: 'color 0.15s, border-color 0.15s',
  });

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
            color: '#000',
            marginTop: 16,
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
          }}>
            CONNECT TO CLAUDE
          </h1>
          <p style={{
            fontFamily: "'VT323', monospace",
            fontSize: '1.1rem',
            color: '#555',
            marginTop: 4,
          }}>
            ONE-TIME SETUP TO LINK YOUR ACCOUNT
          </p>
        </div>

        <div style={{
          background: '#0F0F0F',
          border: '4px solid #2a2a2a',
          borderRadius: 12,
          boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
          display: 'flex',
          flexDirection: 'column',
        }}>
          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid #2a2a2a' }}>
            <button onClick={() => setTab('oauth')} style={tabStyle(tab === 'oauth')}>
              Sign in with Anthropic
            </button>
            <button onClick={() => setTab('legacy')} style={tabStyle(tab === 'legacy')}>
              Paste Token
            </button>
          </div>

          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
            {tab === 'oauth' ? (
              /* ── OAuth Tab ── */
              <>
                {oauthStep === 1 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                    <div style={{
                      fontFamily: "'VT323', monospace",
                      fontSize: '1.1rem',
                      color: '#FFD600',
                      textAlign: 'center',
                    }}>
                      {'>'} STEP 1: AUTHORIZE WITH ANTHROPIC
                    </div>
                    <p style={{
                      fontFamily: "'VT323', monospace",
                      fontSize: '1rem',
                      color: '#AA8800',
                      textAlign: 'center',
                      lineHeight: 1.5,
                    }}>
                      OPENS ANTHROPIC IN A NEW TAB. AUTHORIZE, THEN COPY THE SHORT CODE BACK HERE.
                    </p>
                    <button
                      onClick={handleOAuthStart}
                      disabled={oauthLoading}
                      style={{
                        padding: '14px 32px',
                        borderRadius: 8,
                        background: oauthLoading ? '#555' : '#FFD600',
                        color: '#000',
                        border: 'none',
                        fontFamily: "'VT323', monospace",
                        fontSize: '1.3rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        cursor: oauthLoading ? 'default' : 'pointer',
                        boxShadow: oauthLoading ? 'none' : '0 4px 0 #AA8800, 0 8px 10px rgba(0,0,0,0.15)',
                        transition: 'all 0.1s',
                      }}
                    >
                      {oauthStatus === 'starting' ? 'OPENING...' : 'SIGN IN WITH ANTHROPIC'}
                    </button>
                    {oauthError && (
                      <p style={{
                        fontFamily: "'VT323', monospace",
                        fontSize: '1rem',
                        color: '#ff4444',
                      }}>{oauthError}</p>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div style={{
                      fontFamily: "'VT323', monospace",
                      fontSize: '1.1rem',
                      color: '#FFD600',
                    }}>
                      {'>'} STEP 2: PASTE AUTHORIZATION CODE
                    </div>
                    <p style={{
                      fontFamily: "'VT323', monospace",
                      fontSize: '1rem',
                      color: '#AA8800',
                      lineHeight: 1.5,
                    }}>
                      COPY THE SHORT CODE FROM THE ANTHROPIC PAGE AND PASTE IT BELOW.
                    </p>
                    <input
                      value={oauthCode}
                      onChange={e => { setOauthCode(e.target.value); setOauthError(''); }}
                      placeholder="PASTE CODE HERE..."
                      disabled={oauthLoading}
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
                        fontSize: '1.1rem',
                        border: oauthError ? '2px solid #ff4444' : '2px solid transparent',
                        outline: 'none',
                        opacity: oauthLoading ? 0.5 : 1,
                        boxSizing: 'border-box',
                      }}
                    />
                    {oauthError && (
                      <p style={{
                        fontFamily: "'VT323', monospace",
                        fontSize: '1rem',
                        color: '#ff4444',
                      }}>{oauthError}</p>
                    )}
                    <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                      <button
                        onClick={() => { setOauthStep(1); setOauthCode(''); setOauthError(''); setOauthStatus('idle'); }}
                        disabled={oauthLoading}
                        style={{
                          padding: '10px 20px',
                          borderRadius: 6,
                          background: 'transparent',
                          color: '#AA8800',
                          border: '1px solid #333',
                          fontFamily: "'VT323', monospace",
                          fontSize: '1rem',
                          cursor: oauthLoading ? 'default' : 'pointer',
                        }}
                      >
                        BACK
                      </button>
                      <button
                        onClick={handleOAuthExchange}
                        disabled={oauthLoading || !oauthCode.trim()}
                        style={{
                          padding: '10px 32px',
                          borderRadius: 6,
                          background: (oauthLoading || !oauthCode.trim()) ? '#555' : '#FFD600',
                          color: '#000',
                          border: 'none',
                          fontFamily: "'VT323', monospace",
                          fontSize: '1.1rem',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          cursor: (oauthLoading || !oauthCode.trim()) ? 'default' : 'pointer',
                          boxShadow: (oauthLoading || !oauthCode.trim()) ? 'none' : '0 3px 0 #AA8800',
                        }}
                      >
                        {oauthStatus === 'exchanging' ? 'CONNECTING...' : oauthStatus === 'polling' ? 'BOOTING...' : 'CONNECT'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* ── Legacy Tab ── */
              <>
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
                    onChange={e => { setToken(e.target.value); setLegacyError(''); }}
                    placeholder="SK-ANT-OAT01-..."
                    disabled={legacyLoading}
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
                      border: legacyError ? '2px solid #ff4444' : '2px solid transparent',
                      outline: 'none',
                      opacity: legacyLoading ? 0.5 : 1,
                      boxSizing: 'border-box',
                    }}
                  />
                  {legacyError && (
                    <p style={{
                      fontFamily: "'VT323', monospace",
                      fontSize: '1rem',
                      color: '#ff4444',
                      marginTop: 8,
                    }}>{legacyError}</p>
                  )}
                </div>

                <button
                  onClick={handleLegacyConnect}
                  disabled={legacyLoading || !token.trim()}
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: '50%',
                    background: (legacyLoading || !token.trim()) ? '#555' : '#E5E5E5',
                    color: '#333',
                    border: '1px solid #999',
                    boxShadow: (legacyLoading || !token.trim()) ? 'none' : '0 4px 0 #999, 0 8px 10px rgba(0,0,0,0.15)',
                    fontFamily: "'VT323', monospace",
                    fontSize: '1rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                    cursor: (legacyLoading || !token.trim()) ? 'default' : 'pointer',
                    transition: 'all 0.1s',
                    alignSelf: 'center',
                  }}
                >
                  {legacyStatus === 'loading' ? '...' : legacyStatus === 'polling' ? 'BOOT' : 'GO'}
                </button>
              </>
            )}
          </div>
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

/* ── Artifact Viewer (retro themed) ──────────────────────────────────────── */

function ArtifactViewer({ activeArtifact, artifacts, onSelect }) {
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
    <div className="flex flex-col" style={{
      flex: 1,
      minHeight: 0,
      background: '#0F0F0F',
      border: '4px solid #2a2a2a',
      borderRadius: 12,
      overflow: 'hidden',
      boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)',
      position: 'relative',
    }}>
      {/* CRT overlay */}
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

      {/* Header bar */}
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
        }}>DISPLAY://</span>

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
            }}
            title="OPEN IN NEW TAB"
          >&#8599;</a>
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
          sandbox="allow-scripts allow-popups"
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

// === Window Exports (for App component) ===
if (typeof window !== 'undefined') {
  window.escapeHtml = escapeHtml;
  window.truncate = truncate;
  window.renderMarkdown = renderMarkdown;
  window.formatToolInput = formatToolInput;
  window.PixelFace = PixelFace;
  window.StatusDots = StatusDots;
  window.JulianScreenEmbed = JulianScreenEmbed;
  window.ThinkingDots = ThinkingDots;
  window.ToolCallBlock = ToolCallBlock;
  window.MessageBubble = MessageBubble;
  window.SetupScreen = SetupScreen;
  window.ChatInput = ChatInput;
  window.ArtifactViewer = ArtifactViewer;
  window.EggHatch = EggHatch;
  window.AgentGrid = AgentGrid;
  window.AgentFaceHeader = AgentFaceHeader;
  window.hashNameToFaceVariant = hashNameToFaceVariant;
  window.AGENT_COLORS = AGENT_COLORS;
  window.EYE_VARIANTS = EYE_VARIANTS;
  window.MOUTH_VARIANTS = MOUTH_VARIANTS;
  window.GENDER_MARKERS = GENDER_MARKERS;
}