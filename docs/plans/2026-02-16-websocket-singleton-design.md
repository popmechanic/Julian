# JulianScreen WebSocket Singleton

**Date:** 2026-02-16
**Status:** Implemented

## Problem

The JulianScreen WebSocket connection (`/screen/ws`) is owned by React components. This causes three failures:

1. **Duplicate connections.** Mobile and desktop layouts each render a `JulianScreenEmbed` instance. Both mount simultaneously. Both open their own WebSocket to the same endpoint. One is always wasted.

2. **Mount/unmount churn.** React can mount a component, unmount it within milliseconds (StrictMode, conditional branches, layout switches), then remount it. Each cycle creates a WebSocket, closes it mid-handshake, and creates another. This produces "WebSocket is closed before the connection is established" errors and puts unnecessary load on the Bun server's proxy.

3. **No shared state.** Each instance tracks its own `connected` state, reconnect timer, and backoff counter. They can't coordinate.

### Incident history (2026-02-16)

These WebSocket issues were part of a larger cascade that corrupted Fireproof data and took down sync:

1. **Connect server crash.** The nginx proxy on `connect-share.exe.xyz` forwarded empty `Upgrade: ` headers on PUT requests to `/fp`. The workerd runtime interpreted these as malformed WebSocket upgrades on a non-GET method and crashed. Fix: removed WebSocket upgrade headers from the `/fp` location block (they belong only on `/ws`).

2. **Corrupted CRDT blocks.** The workerd crashes interrupted Fireproof sync mid-transfer. The local IndexedDB retained metadata pointing to blocks that never arrived. Every query hit `missing block: bafyrei...` errors.

3. **Failed IndexedDB migration.** The existing migration script filtered for databases with "fireproof" in the name. Fireproof actually names its IndexedDB databases with an `fp.` prefix (e.g., `fp.julian-chat-v2`, `fp-keybag`). The filter matched nothing. Fix: wipe all IndexedDB databases on version bump.

4. **Cloud ledger reuse.** Bumping the database name from `julian-chat-v2` to `julian-chat-v3` changed the local database but not the cloud ledger. The vibes bridge's hostname-based discovery (`l.name.includes(appHost)`) matched the old corrupted ledger because both names contained `julian.exe.xyz`. Fix: match by full `appId` instead of hostname, so each database version gets its own cloud ledger.

5. **Agent seed race condition.** On fresh databases, the agent seed effect called `database.put()` before Fireproof's cloud stores finished attaching. The `WriteQueueImpl` threw `Cannot read properties of undefined (reading 'stores')`. Fix: `await database.ready()` plus backoff retry.

6. **JulianScreen WebSocket churn.** Two simultaneous `JulianScreenEmbed` instances created duplicate connections. React mount/unmount cycles closed connections mid-handshake. Current workaround: 200ms delay before connecting. This is a hack — the real fix is this design.

## Solution: Singleton WebSocket Manager

Follow Fireproof's own pattern. Fireproof stores its WebSocket in a `VirtualConnected` class (plain JavaScript, no React). The connection persists for the page lifetime. Components subscribe to status via window globals and custom events.

### Architecture

```
window.JulianScreenWS (singleton, created once at page load)
  ├── ws: WebSocket          — single connection to /screen/ws
  ├── connected: boolean     — current state
  ├── connect()              — idempotent, creates WS if none exists
  ├── send(msg)              — sends if connected, drops if not
  └── _broadcast(connected)  — fires CustomEvent for subscribers

JulianScreenEmbed (React component, may exist 0-N times)
  ├── useEffect → listen for 'julian-screen-status' event
  ├── renders canvas, calls JScreen.init()
  └── NO WebSocket logic — pure rendering
```

### The singleton

Defined in `chat.jsx` at script scope (outside any component), exported to `window.JulianScreenWS`:

```javascript
const JulianScreenWS = {
  ws: null,
  connected: false,
  _reconnectTimer: null,
  _reconnectDelay: 2000,

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN ||
        this.ws?.readyState === WebSocket.CONNECTING) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = location.hostname === 'localhost'
      ? 'ws://localhost:3848/ws'
      : `${proto}//${location.host}/screen/ws`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._reconnectDelay = 2000;
      this._clearReconnect();
      this._broadcast(true);

      // Wire up JScreen feedback forwarding
      if (window.JScreen) {
        window.JScreen.sendFeedback = (event) => {
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
      this.connected = false;
      this.ws = null;
      this._broadcast(false);
      this._scheduleReconnect();
    };

    ws.onerror = () => { ws.close(); };
  },

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  },

  _broadcast(connected) {
    window.dispatchEvent(new CustomEvent('julian-screen-status',
      { detail: { connected } }));
  },

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
  },

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
};

window.JulianScreenWS = JulianScreenWS;
JulianScreenWS.connect();
```

### The component

`JulianScreenEmbed` becomes a pure rendering component. No WebSocket logic:

```javascript
function JulianScreenEmbed({ sessionActive, compact, onFileSelect, onMenuTab, noBorder }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [connected, setConnected] = useState(window.JulianScreenWS?.connected || false);

  // Subscribe to singleton status
  useEffect(() => {
    const handler = (e) => setConnected(e.detail.connected);
    window.addEventListener('julian-screen-status', handler);
    return () => window.removeEventListener('julian-screen-status', handler);
  }, []);

  // Initialize JulianScreen canvas (unchanged)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !window.JScreen) return;
    window.JScreen.init(canvas);
    // ...
  }, []);

  // ... render canvas, no WebSocket refs, no reconnect timers
}
```

### What changes

| Before | After |
|---|---|
| WebSocket created in `useEffect` | WebSocket created at script scope |
| 2 connections (mobile + desktop) | 1 connection (singleton) |
| Connection destroyed on unmount | Connection persists for page lifetime |
| `connected` state per-instance | `connected` broadcast via CustomEvent |
| Reconnect timer per-instance | Single reconnect timer in singleton |
| 200ms delay hack needed | No delay needed |

### File changes

| File | Change |
|---|---|
| `chat.jsx` | Add `JulianScreenWS` singleton at script scope. Remove WebSocket logic from `JulianScreenEmbed`. Component subscribes to `julian-screen-status` event. |
| `index.html` | No changes needed. Both `JulianScreenEmbed` instances continue to render — they just subscribe to the same singleton. |

### What stays the same

- Canvas rendering and `JScreen.init()` — still per-component
- `onFileSelect` and `onMenuTab` callbacks — still per-component via refs
- The Bun server's WebSocket proxy (`server.ts`) — unchanged
- Fireproof's own WebSocket management — independent, unaffected
