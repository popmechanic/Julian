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
    <div class="empty">Select an artifact — letters render with their typography.</div>
  {/if}
</section>

<style>
  .artifacts {
    display: grid;
    grid-template-columns: 16rem 1fr;
    height: 100%;
    min-height: 0;
  }
  nav {
    overflow-y: auto;
    border-right: 1px solid var(--border, #333);
    padding: 0.5rem;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    background: white;
  }
  .empty {
    display: grid;
    place-items: center;
    opacity: 0.5;
    padding: 1rem;
    text-align: center;
  }
  .error {
    color: #e66;
  }
</style>
