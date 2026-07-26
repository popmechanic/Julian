<!-- app/src/components/FaceHeader.svelte -->
<!-- The face header of the chat machine (legacy index.html left-column header). -->
<script lang="ts">
  import PixelFace from './PixelFace.svelte';

  let { sessionActive, processing = false, onEnd }: {
    sessionActive: boolean; processing?: boolean; onEnd: () => void;
  } = $props();

  const status = $derived(!sessionActive ? 'OFFLINE' : processing ? 'PROCESSING...' : 'LISTENING');
</script>

<header class="face-header">
  <span class="sysver">SYS.VER.3.0</span>
  <span class="status-dots" class:ok={sessionActive}>
    <span class="sdot"></span><span class="sdot"></span><span class="sdot"></span>
  </span>
  <div class="row">
    <PixelFace talking={processing} size={56} />
    <div class="who">
      <div class="name">JULIAN</div>
      <div class="state">{status}</div>
    </div>
    {#if sessionActive}
      <button class="end" onclick={onEnd}>END</button>
    {/if}
  </div>
</header>

<style>
  .face-header {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-bottom: 1px dashed var(--j-gray-333);
    border-radius: 12px 12px 0 0;
    padding: 12px 16px;
    box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.5);
    position: relative;
    flex-shrink: 0;
  }
  .sysver {
    position: absolute;
    top: 8px;
    left: 12px;
    font-family: var(--font-terminal);
    font-size: 0.75rem;
    color: var(--j-yellow-dim);
    letter-spacing: 0.2em;
  }
  .status-dots { position: absolute; top: 10px; right: 12px; display: flex; gap: 4px; }
  .sdot { width: 6px; height: 6px; border-radius: 50%; background: var(--j-gray-444); }
  .status-dots.ok .sdot { background: var(--j-green); box-shadow: 0 0 4px var(--j-green); }
  .status-dots:not(.ok) .sdot:first-child { background: var(--j-red); animation: pulse-warn 2s ease-in-out infinite; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 16px; width: 100%; }
  .who { flex: 1; }
  .name {
    font-family: var(--font-terminal);
    font-size: 1.4rem;
    color: var(--j-yellow);
    letter-spacing: 0.05em;
  }
  .state {
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    color: var(--j-yellow-dim);
    opacity: 0.8;
  }
  .end {
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    color: var(--j-red);
    background: var(--j-red-black);
    border: 1px solid var(--j-gray-333);
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
    text-transform: uppercase;
  }
</style>
