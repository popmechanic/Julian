// JulianScreen — Bun HTTP + WebSocket server
// Agent sends commands via POST /cmd, browser renders via WebSocket

import { parseCommand } from './protocol.js';

const PORT = parseInt(process.env.JULIANSCREEN_PORT || '3848');
const TICK_INTERVAL = parseInt(process.env.TICK_INTERVAL || '0'); // 0 = disabled

// Connected WebSocket clients
const clients = new Set();

// Feedback queue (browser → agent via GET /feedback)
let feedbackQueue = [];
const MAX_FEEDBACK = 200;

function queueFeedback(event) {
  feedbackQueue.push(event);
  if (feedbackQueue.length > MAX_FEEDBACK) {
    feedbackQueue = feedbackQueue.slice(-MAX_FEEDBACK);
  }
}

// Broadcast parsed commands to all WS clients
function broadcast(commands) {
  const payload = JSON.stringify(commands);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

// Optional server-side tick
let tickTimer = null;
if (TICK_INTERVAL > 0) {
  tickTimer = setInterval(() => {
    queueFeedback({ type: 'TICK', ts: Date.now() });
  }, TICK_INTERVAL);
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return undefined;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // POST /cmd — receive commands from agent
    if (req.method === 'POST' && url.pathname === '/cmd') {
      return (async () => {
        const body = await req.text();
        const lines = body.split('\n');
        const commands = [];

        for (const line of lines) {
          const cmd = parseCommand(line);
          if (cmd) commands.push(cmd);
        }

        if (commands.length > 0) {
          broadcast(commands);
        }

        return new Response(JSON.stringify({ ok: true, parsed: commands.length }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      })();
    }

    // GET /feedback — agent polls for browser events
    if (req.method === 'GET' && url.pathname === '/feedback') {
      const events = feedbackQueue;
      feedbackQueue = [];
      return new Response(JSON.stringify(events), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        connections: clients.size,
        queueDepth: feedbackQueue.length,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Serve client files
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(Bun.file(new URL('../client/index.html', import.meta.url)));
    }

    // Serve other client files
    const clientPath = url.pathname.replace(/^\//, '');
    const clientFile = Bun.file(new URL(`../client/${clientPath}`, import.meta.url));
    if (clientFile.size > 0) {
      return new Response(clientFile);
    }

    // Serve sprite files
    const spritePath = url.pathname.replace(/^\/sprites\//, '');
    if (url.pathname.startsWith('/sprites/')) {
      const spriteFile = Bun.file(new URL(`../sprites/${spritePath}`, import.meta.url));
      return new Response(spriteFile, {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[ws] Client connected (${clients.size} total)`);
      // Send READY signal
      ws.send(JSON.stringify([{ type: 'READY' }]));
    },

    message(ws, message) {
      // Browser sends feedback events
      try {
        const event = JSON.parse(message);
        if (event && event.type) {
          queueFeedback(event);
        }
      } catch {
        console.error('[ws] Invalid message from client');
      }
    },

    close(ws) {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (${clients.size} total)`);
    },
  },
});

console.log(`[JulianScreen] Server running on http://localhost:${PORT}`);
console.log(`[JulianScreen] WebSocket at ws://localhost:${PORT}/ws`);
console.log(`[JulianScreen] POST /cmd to send commands, GET /feedback for events`);
