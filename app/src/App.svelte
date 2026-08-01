<!-- app/src/App.svelte -->
<!--
  The running SPA shell. Boot sequence: initAuth → startPersistence →
  connectEvents → startSync. Layout: the yellow room holds the chat machine
  (face header + chat) on the left and the glass-tab console (screen /
  artifacts) on the right; below 768px the two stack. Processing state is
  driven by claude_result / session_* ephemeral events delivered through
  connectEvents' onEphemeral.
-->
<script lang="ts">
  import { initAuth, getToken, signOut, authEnabled } from './lib/auth';
  import { startPersistence, startSync } from './lib/store';
  import { connectEvents, type ServerEvent } from './lib/events';
  import { startSession, endSession, fetchHealth, fetchArtifactTree, type ArtifactEntry } from './lib/api';
  import { sfx } from './lib/sfx';
  import SetupScreen from './components/SetupScreen.svelte';
  import FaceHeader from './components/FaceHeader.svelte';
  import PixelFace from './components/PixelFace.svelte';
  import ChatView from './components/ChatView.svelte';
  import BrowserPanel from './components/BrowserPanel.svelte';
  import FilesPanel from './components/FilesPanel.svelte';
  import ScreenEmbed from './components/ScreenEmbed.svelte';
  import SyncStatus from './components/SyncStatus.svelte';
  import JobsBoard from './components/JobsBoard.svelte';

  let booted = $state(false);
  let sfxMuted = $state(false);
  let ready = $state(false);
  let sessionActive = $state(false);
  let processing = $state(false);
  let tab = $state<'screen' | 'browser' | 'files'>('screen');
  let entries = $state<ArtifactEntry[]>([]);
  let activeArtifact = $state<string | null>(null);
  let showBoard = $state(false);

  // BROWSER dropdown lists renderable files (legacy listed .html; letters are
  // .md and render server-side, so both belong here).
  const artifacts = $derived.by(() => {
    const out: { name: string; modified?: number }[] = [];
    const walk = (list: ArtifactEntry[], prefix: string) => {
      for (const e of list) {
        if (e.type === 'folder' && e.children) walk(e.children, prefix ? `${prefix}/${e.name}` : e.name);
        else if (e.type === 'file' && (e.name.endsWith('.html') || e.name.endsWith('.md')))
          out.push({ name: prefix ? `${prefix}/${e.name}` : e.name, modified: e.modified });
      }
    };
    walk(entries, '');
    return out;
  });

  // Legacy handleFileSelect: renderable files jump to the browser tab.
  function handleFileSelect(path: string) {
    if (path.endsWith('.html') || path.endsWith('.md')) {
      activeArtifact = path;
      tab = 'browser';
    }
  }

  function handleEphemeral(e: ServerEvent) {
    if (e.type === 'session_start') sessionActive = true;
    if (e.type === 'session_end') {
      sessionActive = false;
      processing = false;
    }
    if (e.type === 'user_message') processing = true;
    if (e.type === 'claude_result') processing = false;
  }

  $effect(() => {
    (async () => {
      await initAuth();
      await startPersistence();
      sfxMuted = sfx.isMuted();
      booted = true;
    })();
  });

  // The jobs board opens itself on a `list` marker — pull-only (design spec §3).
  $effect(() => {
    const open = () => { showBoard = true; };
    window.addEventListener('julian:jobs-list', open);
    return () => window.removeEventListener('julian:jobs-list', open);
  });

  // Authed connections start only after SetupScreen clears (signed in + no setup
  // needed) — polling before then just 401s against the auth-gated server.
  $effect(() => {
    if (!ready) return;
    const conn = connectEvents({ onEphemeral: handleEphemeral });
    startSync(getToken);
    fetchHealth().then((h) => (sessionActive = h.sessionActive));
    return () => conn.stop();
  });

  // The artifact tree feeds both BROWSER and FILES; refresh whenever either
  // opens so newly written artifacts appear (legacy refreshed via menu data).
  $effect(() => {
    if (!ready || tab === 'screen') return;
    fetchArtifactTree()
      .then((e) => (entries = e))
      .catch((err) => console.error('[artifacts] tree fetch failed:', err));
  });
</script>

{#if !booted}
  <div class="boot app-state-enter">
    <PixelFace size={200} />
    <div class="boot-label">WAKING…</div>
  </div>
{:else if !ready}
  <SetupScreen onReady={() => (ready = true)} />
{:else}
  <div class="room app-state-enter">
    <div class="machine">
      <FaceHeader
        {sessionActive}
        {processing}
        onEnd={() => endSession()}
        onEndFinal={() => {
          if (confirm('End this session for good? The next one starts fresh, inheriting the recent record.')) endSession(true);
        }}
      />
      <ChatView {processing} {sessionActive} onStart={() => { sfx.playBoot(); startSession(); }} />
    </div>
    <aside class="console">
      <nav class="tabbar">
        {#each ['screen', 'browser', 'files'] as const as t (t)}
          <button
            class="pill"
            class:active={tab === t}
            onclick={() => { if (tab !== t) { sfx.play('tab'); tab = t; } }}
          >{t.toUpperCase()}</button>
        {/each}
        <button
          class="pill"
          class:active={showBoard}
          onclick={() => (showBoard = !showBoard)}
        >BOARD</button>
        <span class="spacer"></span>
        <SyncStatus />
        <button
          class="mute"
          class:muted={sfxMuted}
          title={sfxMuted ? 'Sound off' : 'Sound on'}
          onclick={() => (sfxMuted = sfx.mute())}
        >{sfxMuted ? '🔇' : '🔊'}</button>
        {#if authEnabled()}
          <button
            class="logout"
            onclick={async () => { await signOut(); ready = false; }}
          >LOGOUT</button>
        {/if}
      </nav>
      <div class="console-body">
        {#if tab === 'screen'}
          <ScreenEmbed {sessionActive} />
        {:else if tab === 'browser'}
          <BrowserPanel {artifacts} active={activeArtifact} onSelect={(n) => (activeArtifact = n)} />
        {:else}
          <FilesPanel {entries} onFileSelect={handleFileSelect} />
        {/if}
      </div>
    </aside>
    {#if showBoard}
      <aside class="console board-panel">
        <JobsBoard />
      </aside>
    {/if}
  </div>
{/if}

<style>
  .boot {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 32px;
    height: 100vh;
    background: var(--j-crt-2);
  }
  .boot-label {
    font-family: var(--font-terminal);
    font-size: 18px;
    color: var(--j-yellow);
    letter-spacing: 0.2em;
    animation: blink 1.4s step-end infinite;
  }
  .room {
    display: flex;
    height: 100vh;
    padding: 16px;
    gap: 16px;
    background-color: var(--j-yellow);
  }
  .machine {
    width: 420px;
    min-width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .console {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    border: 1px solid var(--j-gray-333);
    border-radius: 12px;
    background: var(--j-crt-1);
    overflow: hidden;
  }
  .tabbar {
    display: flex;
    align-items: center;
    padding: 0 12px;
    gap: 6px;
    height: 48px;
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .pill {
    height: 32px;
    padding: 0 14px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    display: flex;
    align-items: center;
    font-size: 10px;
    font-family: var(--font-ui);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 300ms ease, color 300ms ease, border-color 300ms ease, box-shadow 300ms ease;
  }
  .pill:hover:not(.active) { background: var(--j-cyan); color: #000; border-color: var(--j-cyan); }
  .pill.active {
    background: var(--j-cyan);
    border-color: var(--j-cyan);
    color: #000;
    font-weight: 700;
    cursor: default;
    box-shadow: 0 0 15px rgba(0, 175, 209, 0.3);
  }
  .spacer { flex: 1; }
  /* Legacy index.html mute button: 32px circle, speaker emoji, soft hover. */
  .mute {
    height: 32px;
    width: 32px;
    padding: 0;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    transition: background 300ms ease, color 300ms ease, border-color 300ms ease;
  }
  .mute.muted { color: rgba(255, 255, 255, 0.3); }
  .mute:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
  /* Legacy index.html LOGOUT pill: tab-pill geometry, red hover. */
  .logout {
    height: 32px;
    padding: 0 14px;
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-family: var(--font-ui);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.15em;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 300ms ease, color 300ms ease, border-color 300ms ease;
  }
  .logout:hover { background: #ef4444; color: #fff; border-color: #ef4444; }
  .console-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .board-panel { flex: 0 0 320px; width: 320px; }

  /* Mobile: stacked machine, console content inline (legacy < 768px layout) */
  @media (max-width: 767px) {
    .room { flex-direction: column; padding: 8px; gap: 8px; }
    .machine { width: 100%; min-width: 0; flex: 1; min-height: 0; }
    .console { flex: none; height: 40vh; }
    .board-panel { width: 100%; flex-basis: auto; }
  }
</style>
