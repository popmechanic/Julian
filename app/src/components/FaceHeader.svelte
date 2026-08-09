<!-- app/src/components/FaceHeader.svelte -->
<!-- The face header of the chat machine (legacy index.html left-column header). -->
<script module lang="ts">
  export function statusFor(sessionActive: boolean, processing: boolean): string {
    if (!sessionActive) return 'ASLEEP';
    return processing ? 'PROCESSING...' : 'LISTENING';
  }
</script>

<script lang="ts">
  import PixelFace from './PixelFace.svelte';

  let { sessionActive, processing = false, onEnd, onEndFinal }: {
    sessionActive: boolean; processing?: boolean; onEnd: () => void; onEndFinal: () => void;
  } = $props();

  const status = $derived(statusFor(sessionActive, processing));
</script>

<header class="face-header">
  <span class="sysver">SYS.VER.3.0</span>
  <span class="status-dots" class:ok={sessionActive}>
    <span class="sdot"></span><span class="sdot"></span><span class="sdot"></span>
  </span>
  <div class="row">
    <PixelFace talking={processing} sleeping={!sessionActive} size={56} />
    <div class="who">
      <div class="name">JULIAN</div>
      <div class="state">{status}</div>
    </div>
    {#if sessionActive}
      <button class="end" title="Pause — Julian resumes this same session next start" onclick={onEnd}>REST</button>
      <button class="end-final danger" title="Ends this session permanently — the next one starts fresh" onclick={onEndFinal}>END FOR GOOD</button>
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
  /* Legacy chat.jsx StatusDots: 8x8 SQUARES. Offline: all three red, staggered
     warn pulse. Active: first yellow with glow pulse, rest #333. */
  .status-dots { position: absolute; top: 10px; right: 12px; display: flex; gap: 4px; align-items: center; }
  .sdot { width: 8px; height: 8px; }
  .status-dots:not(.ok) .sdot { background: var(--j-red-soft); animation: pulse-warn 2s ease-in-out infinite; }
  .status-dots:not(.ok) .sdot:nth-child(1) { box-shadow: 0 0 4px var(--j-red-soft); }
  .status-dots:not(.ok) .sdot:nth-child(2) { opacity: 0.5; animation-delay: 0.2s; }
  .status-dots:not(.ok) .sdot:nth-child(3) { opacity: 0.3; animation-delay: 0.4s; }
  .status-dots.ok .sdot:nth-child(1) { background: var(--j-yellow); box-shadow: 0 0 5px var(--j-yellow); animation: pulse-dot 2s ease-in-out infinite; }
  .status-dots.ok .sdot:nth-child(2),
  .status-dots.ok .sdot:nth-child(3) { background: var(--j-gray-333); }
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
  /* Deliberate final end: smaller and unfilled next to the primary REST
     control, but outlined in danger red — the rarer, weightier action, never a
     second pause button. Its casing stays uppercase so the rendered label is
     the one the title promises: END FOR GOOD. */
  .end-final {
    font-family: var(--font-terminal);
    font-size: 0.7rem;
    color: var(--j-gray-666);
    background: transparent;
    border: 1px solid var(--j-gray-666);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
    text-transform: uppercase;
    transition: color 200ms ease, border-color 200ms ease;
  }
  .end-final:hover {
    color: var(--j-red);
  }
  .end-final.danger {
    border-color: var(--j-red-dim, var(--j-red));
    color: var(--j-red-dim, var(--j-red));
  }
  .end-final.danger:hover {
    color: var(--j-red);
    border-color: var(--j-red);
  }
</style>
