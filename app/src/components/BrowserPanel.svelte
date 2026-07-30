<!-- app/src/components/BrowserPanel.svelte -->
<!--
  BROWSER tab — port of the legacy chat.jsx ArtifactViewer: DISPLAY:// header
  with a VT323 dropdown selector, an open-in-new-tab pill, and a sandboxed
  iframe onto the server-rendered artifact. Letters (.md) render server-side,
  so the dropdown lists both .html and .md files.
-->
<script lang="ts">
  import { sfx } from '../lib/sfx';

  let { artifacts, active, onSelect }: {
    artifacts: { name: string; modified?: number }[];
    active: string | null;
    onSelect: (name: string) => void;
  } = $props();

  let open = $state(false);
  let dropdown: HTMLDivElement | undefined = $state();

  $effect(() => {
    function handle(e: MouseEvent) {
      if (dropdown && !dropdown.contains(e.target as Node)) open = false;
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  });

  const href = $derived(
    active ? `/api/artifacts/${active.split('/').map(encodeURIComponent).join('/')}` : null,
  );
</script>

<div class="viewer">
  <div class="header">
    <span class="proto">DISPLAY://</span>
    <div class="dropdown" bind:this={dropdown}>
      <button
        class="select"
        class:has={!!active}
        onclick={() => { sfx.play(open ? 'close' : 'open'); open = !open; }}
      >
        <span class="sel-label">{active || 'SELECT FILE...'}</span>
        <span class="caret">{open ? '▲' : '▼'}</span>
      </button>
      {#if open && artifacts.length > 0}
        <div class="menu">
          {#each artifacts as f (f.name)}
            <button
              class="opt"
              class:active={f.name === active}
              onclick={() => { onSelect(f.name); open = false; }}
            >{f.name}</button>
          {/each}
        </div>
      {/if}
    </div>
    {#if href}
      <a class="pop" href={href} target="_blank" rel="noopener noreferrer" title="OPEN IN NEW TAB">&#8599;</a>
    {/if}
  </div>

  {#if href}
    {#key active}
      <iframe src={href} title={active} sandbox="allow-scripts allow-popups"></iframe>
    {/key}
  {:else}
    <div class="empty">
      <div class="pixelgrid">
        {#each Array.from({ length: 64 }, (_, i) => i) as i (i)}
          <div class="px" class:lit={i % 7 === 0 || i % 11 === 0}></div>
        {/each}
      </div>
      <div class="caption">
        {artifacts.length > 0 ? '> SELECT ARTIFACT TO DISPLAY' : '> AWAITING ARTIFACT GENERATION'}
      </div>
      <div class="subcaption">JULIAN WILL CREATE ARTIFACTS HERE</div>
    </div>
  {/if}
</div>

<style>
  .viewer {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #0c0c0c;
    overflow: hidden;
    position: relative;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    background: rgba(255, 255, 255, 0.03);
    min-height: 50px;
    position: relative;
    z-index: 10;
  }
  .proto {
    color: var(--j-yellow-dim);
    font-size: 0.85rem;
    font-family: var(--font-terminal);
    letter-spacing: 0.15em;
  }
  .dropdown { position: relative; flex: 1; }
  .select {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    background: #1a1a00;
    border: 2px solid #333;
    border-radius: 4px;
    color: #666;
    font-family: var(--font-terminal);
    font-size: 1rem;
    text-align: left;
    cursor: pointer;
    text-transform: uppercase;
  }
  .select.has { color: var(--j-yellow); }
  .sel-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { color: #666; font-size: 10px; }
  .menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: #0c0c0c;
    border: 1px solid #333;
    border-radius: 4px;
    z-index: 50;
    max-height: 300px;
    overflow-y: auto;
    transform-origin: top;
  }
  .opt {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    font-family: var(--font-terminal);
    font-size: 1rem;
    color: var(--j-yellow-dim);
    background: transparent;
    border: none;
    border-bottom: 1px solid #1a1a1a;
    cursor: pointer;
    text-transform: uppercase;
  }
  .opt:hover, .opt.active { background: #1a1a00; }
  .opt.active { color: var(--j-yellow); }
  .pop {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: #e5e5e5;
    color: #333;
    border: 1px solid #999;
    box-shadow: 0 3px 0 #999, 0 6px 8px rgba(0, 0, 0, 0.15);
    text-decoration: none;
    font-family: var(--font-terminal);
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: none;
    background: #fff;
    border-radius: 0 0 8px 8px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
  }
  .pixelgrid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; opacity: 0.15; }
  .px { width: 6px; height: 6px; background: var(--j-gray-333); }
  .px.lit { background: var(--j-yellow); }
  .caption {
    font-family: var(--font-terminal);
    font-size: 1.2rem;
    color: var(--j-gray-444);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    text-align: center;
  }
  .subcaption { font-family: var(--font-terminal); font-size: 0.9rem; color: var(--j-gray-333); text-align: center; }
</style>
