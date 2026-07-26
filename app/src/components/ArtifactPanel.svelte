<!-- app/src/components/ArtifactPanel.svelte -->
<!-- Collapsible memory/ tree; selecting a file navigates a sandboxed iframe to the -->
<!-- server-rendered artifact. Letters render server-side — this panel only navigates. -->
<script lang="ts">
  import { fetchArtifactTree, type ArtifactEntry } from '../lib/api';
  import ArtifactTree from './ArtifactTree.svelte';

  let entries = $state<ArtifactEntry[]>([]);
  let selected = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    fetchArtifactTree()
      .then((e) => (entries = e))
      .catch((err) => (error = String(err)));
  });

  const iframeSrc = $derived(
    selected ? `/api/artifacts/${selected.split('/').map(encodeURIComponent).join('/')}` : null,
  );
</script>

<section class="artifacts">
  <nav>
    {#if error}<p class="error">{error}</p>{/if}
    <ArtifactTree {entries} onSelect={(p) => (selected = p)} />
  </nav>
  {#if iframeSrc}
    <iframe title="artifact" src={iframeSrc} sandbox="allow-scripts allow-same-origin"></iframe>
  {:else}
    <div class="empty">
      <div class="pixelgrid">
        {#each Array.from({ length: 64 }, (_, i) => i) as i (i)}
          <div class="px" class:lit={i % 7 === 0 || i % 11 === 0}></div>
        {/each}
      </div>
      <div class="caption">
        {entries.length > 0 ? '> SELECT ARTIFACT TO DISPLAY' : '> AWAITING ARTIFACT GENERATION'}
      </div>
      <div class="subcaption">JULIAN WILL CREATE ARTIFACTS HERE</div>
    </div>
  {/if}
</section>

<style>
  .artifacts { display: grid; grid-template-columns: 16rem 1fr; height: 100%; min-height: 0; background: var(--j-crt-1); }
  nav { overflow-y: auto; border-right: 1px solid var(--j-gray-333); padding: 12px; }
  iframe { width: 100%; height: 100%; border: 0; background: white; border-radius: 0 0 8px 8px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .pixelgrid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; opacity: 0.15; }
  .px { width: 6px; height: 6px; background: var(--j-gray-333); }
  .px.lit { background: var(--j-yellow); }
  .caption { font-family: var(--font-terminal); font-size: 1.2rem; color: var(--j-gray-444); text-transform: uppercase; letter-spacing: 0.1em; text-align: center; }
  .subcaption { font-family: var(--font-terminal); font-size: 0.9rem; color: var(--j-gray-333); text-align: center; }
  .error { color: var(--j-red-soft); font-family: var(--font-terminal); }
</style>
