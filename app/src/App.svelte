<!-- app/src/App.svelte -->
<!--
  The running SPA shell. Boot sequence: initClerk → startPersistence →
  connectEvents → startSync. Layout: session bar / chat | right column
  (screen + artifacts tab). Processing state is driven by claude_result /
  session_* ephemeral events delivered through connectEvents' onEphemeral.
-->
<script lang="ts">
  import { initClerk, getToken } from './lib/clerk';
  import { startPersistence, startSync } from './lib/store';
  import { connectEvents, type ServerEvent } from './lib/events';
  import { startSession, endSession, fetchHealth } from './lib/api';
  import SetupScreen from './components/SetupScreen.svelte';
  import SessionBar from './components/SessionBar.svelte';
  import ChatView from './components/ChatView.svelte';
  import ArtifactPanel from './components/ArtifactPanel.svelte';
  import ScreenEmbed from './components/ScreenEmbed.svelte';
  import SyncStatus from './components/SyncStatus.svelte';

  let booted = $state(false);
  let ready = $state(false);
  let sessionActive = $state(false);
  let processing = $state(false);
  let tab = $state<'screen' | 'artifacts'>('screen');

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
      await initClerk();
      await startPersistence();
      booted = true;
    })();
  });

  // Authed connections start only after SetupScreen clears (signed in + no setup
  // needed) — polling before then just 401s against the Clerk-gated server.
  $effect(() => {
    if (!ready) return;
    const conn = connectEvents({ onEphemeral: handleEphemeral });
    startSync(getToken);
    fetchHealth().then((h) => (sessionActive = h.sessionActive));
    return () => conn.stop();
  });
</script>

{#if !booted}
  <div class="boot">Waking…</div>
{:else if !ready}
  <SetupScreen onReady={() => (ready = true)} />
{:else}
  <div class="layout">
    <SessionBar {sessionActive} onStart={() => startSession()} onEnd={() => endSession()} />
    <main>
      <ChatView {processing} />
      <aside>
        <nav class="tabs">
          <button class:active={tab === 'screen'} onclick={() => (tab = 'screen')}>Screen</button>
          <button class:active={tab === 'artifacts'} onclick={() => (tab = 'artifacts')}>Artifacts</button>
          <SyncStatus />
        </nav>
        {#if tab === 'screen'}
          <ScreenEmbed {sessionActive} />
        {:else}
          <ArtifactPanel />
        {/if}
      </aside>
    </main>
  </div>
{/if}

<style>
  .boot {
    display: grid;
    place-items: center;
    height: 100vh;
  }
  .layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  main {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr minmax(20rem, 32rem);
    min-height: 0;
  }
  aside {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border, #333);
    min-height: 0;
  }
  .tabs {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.5rem;
  }
  .tabs .active {
    font-weight: 700;
  }
</style>
