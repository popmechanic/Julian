<!-- app/src/components/ArtifactTree.svelte -->
<!-- Recursive, collapsible tree of ArtifactEntry nodes (Task 7's fetchArtifactTree shape). -->
<script lang="ts">
  import type { ArtifactEntry } from '../lib/api';
  import ArtifactTree from './ArtifactTree.svelte';

  let { entries, prefix = '', onSelect }: {
    entries: ArtifactEntry[]; prefix?: string; onSelect: (path: string) => void;
  } = $props();

  let open = $state<Record<string, boolean>>({});
</script>

<ul>
  {#each entries as entry (entry.name)}
    {#if entry.type === 'folder'}
      <li>
        <button class="folder" onclick={() => (open[entry.name] = !open[entry.name])}>
          {open[entry.name] ? '▾' : '▸'} {entry.name}
        </button>
        {#if open[entry.name] && entry.children}
          <ArtifactTree entries={entry.children} prefix={`${prefix}${entry.name}/`} {onSelect} />
        {/if}
      </li>
    {:else}
      <li><button class="file" onclick={() => onSelect(`${prefix}${entry.name}`)}>{entry.name}</button></li>
    {/if}
  {/each}
</ul>

<style>
  ul { list-style: none; padding-left: 0.75rem; margin: 0; }
  button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    font-family: var(--font-terminal);
    font-size: 1rem;
    color: var(--j-yellow-dim);
    text-align: left;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .folder { color: var(--j-text-dim); }
  .file:hover, .folder:hover { color: var(--j-yellow); }
</style>
