<!-- app/src/components/ScreenEmbed.svelte -->
<!--
  Connects to the Bun server's /screen/ws proxy (unauthenticated pixel-display
  relay onto ws://localhost:3848/ws — see server/server.ts) and renders
  JulianScreen frames on a 640x480 canvas.

  Frame protocol: ported from the legacy React JulianScreenEmbed in the
  repo's legacy chat.jsx. Its ws.onmessage handling is preserved exactly —
  see parseScreenCommands below — including the JSON array-vs-single-object
  shape and the READY heartbeat filter. The pixel display server itself
  (julianscreen/) is out of scope and is untouched; this component loads its
  existing client engine scripts (already served statically by the Bun
  server) to render the commands it receives.
-->
<script lang="ts" module>
  export interface ScreenCommand {
    type: string;
    [key: string]: unknown;
  }

  declare global {
    interface Window {
      JScreen?: {
        init: (canvas: HTMLCanvasElement) => void;
        initInput?: (canvas: HTMLCanvasElement) => void;
        enqueueCommands: (commands: ScreenCommand[]) => void;
        sendFeedback?: (event: Record<string, unknown>) => void;
        setExternalTabBar?: (val: boolean) => void;
        isMenuActive?: () => boolean;
        exitMenu?: () => void;
      };
    }
  }

  // Preserves the legacy JulianScreenEmbed's ws.onmessage handling exactly:
  //   if (!window.JScreen) return;
  //   try {
  //     const data = JSON.parse(event.data);
  //     if (Array.isArray(data)) {
  //       const cmds = data.filter(c => c.type !== 'READY');
  //       if (cmds.length > 0) window.JScreen.enqueueCommands(cmds);
  //     } else if (data.type && data.type !== 'READY') {
  //       window.JScreen.enqueueCommands([data]);
  //     }
  //   } catch {}
  export function parseScreenCommands(raw: string): ScreenCommand[] {
    try {
      const data: unknown = JSON.parse(raw);
      if (Array.isArray(data)) {
        return (data as ScreenCommand[]).filter((c) => c && c.type !== 'READY');
      }
      const cmd = data as ScreenCommand;
      if (cmd && typeof cmd === 'object' && cmd.type && cmd.type !== 'READY') {
        return [cmd];
      }
      return [];
    } catch {
      return [];
    }
  }

  // The legacy client engine (window.JScreen) is a set of plain global
  // scripts already served by the Bun server. Must load in this order:
  // renderer.js creates window.JScreen, the rest attach handlers to it.
  const ENGINE_SCRIPTS = [
    '/julianscreen/client/renderer.js',
    '/julianscreen/client/sprites.js',
    '/julianscreen/client/tiles.js',
    '/julianscreen/client/text.js',
    '/julianscreen/client/input.js',
    '/julianscreen/client/effects.js',
    '/julianscreen/client/face.js',
    '/julianscreen/client/menu.js',
  ];

  let enginePromise: Promise<void> | undefined;

  function loadScript(src: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(el);
    });
  }

  function loadEngine(): Promise<void> {
    if (!enginePromise) {
      enginePromise = ENGINE_SCRIPTS.reduce(
        (chain, src) => chain.then(() => loadScript(src)),
        Promise.resolve(),
      );
    }
    return enginePromise;
  }
</script>

<script lang="ts">
  let { sessionActive = false }: { sessionActive?: boolean } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();
  let connected = $state(false);
  let engineReady = $state(false);

  $effect(() => {
    if (!canvas) return;
    let closed = false;
    // Commands can arrive (e.g. the server's FACE replay on connect) before
    // the engine scripts finish loading — buffer and flush instead of dropping.
    let pending: ScreenCommand[] = [];

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/screen/ws`);

    ws.onopen = () => {
      connected = true;
      if (window.JScreen) {
        window.JScreen.sendFeedback = (event) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
        };
      }
    };
    ws.onclose = () => {
      connected = false;
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const commands = parseScreenCommands(event.data);
      if (commands.length === 0) return;
      if (engineReady && window.JScreen) window.JScreen.enqueueCommands(commands);
      else pending.push(...commands);
    };

    loadEngine()
      .then(() => {
        if (closed || !canvas || !window.JScreen) return;
        window.JScreen.init(canvas);
        window.JScreen.initInput?.(canvas);
        window.JScreen.setExternalTabBar?.(true);
        if (pending.length > 0) {
          window.JScreen.enqueueCommands(pending);
          pending = [];
        }
        engineReady = true;
      })
      .catch((err) => console.error('[ScreenEmbed] engine load failed:', err));

    return () => {
      closed = true;
      engineReady = false;
      ws.close();
    };
  });

  // Face mode is home whenever the screen is connected: idle if a session is
  // live, sleeping otherwise. (Legacy behavior only left the boot menu once a
  // session started, which stranded the asleep state on the menu's tiny face.)
  $effect(() => {
    if (!connected || !engineReady || !window.JScreen) return;
    if (window.JScreen.isMenuActive?.()) window.JScreen.exitMenu?.();
    window.JScreen.enqueueCommands([
      { type: 'FACE', mode: 'on', state: sessionActive ? 'idle' : 'sleeping' },
    ]);
  });
</script>

<div class="screen" class:connected>
  <canvas bind:this={canvas} width="640" height="480"></canvas>
  <div class="scanlines"></div>
  <span class="dot" class:connected></span>
</div>

<style>
  .screen {
    position: relative;
    aspect-ratio: 4 / 3;
    background: var(--j-crt-0);
    border: 4px solid var(--j-bezel);
    border-radius: 12px;
    overflow: hidden;
    opacity: 0.6;
  }
  .screen.connected {
    opacity: 1;
  }
  .screen :global(.scanlines) {
    border-radius: 12px;
  }
  canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    z-index: 10;
    background: var(--j-red-soft);
    box-shadow: 0 0 4px var(--j-red-soft);
    animation: pulse-warn 2s ease-in-out infinite;
  }
  .dot.connected {
    background: var(--j-yellow);
    box-shadow: 0 0 6px var(--j-yellow);
    animation: none;
  }
</style>
