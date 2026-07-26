<!-- app/src/components/FilesPanel.svelte -->
<!--
  FILES tab — port of the legacy chat.jsx ScreenGridPanel: breadcrumb plus a
  4-column grid of glowing folder/file icons over the /api/artifacts tree.
  Folders drill in; the breadcrumb backs out; files hand off via onFileSelect
  (the shell switches renderable ones to the BROWSER tab, as legacy did).
-->
<script lang="ts">
  import type { ArtifactEntry } from '../lib/api';

  let { entries, rootLabel = 'memory', onFileSelect }: {
    entries: ArtifactEntry[];
    rootLabel?: string;
    onFileSelect: (path: string) => void;
  } = $props();

  let path = $state<string[]>([]);

  const items = $derived.by(() => {
    let cur = entries;
    for (const segment of path) {
      const found = cur.find((e) => e.name === segment && e.type === 'folder');
      if (found?.children) cur = found.children;
      else return [];
    }
    return [...cur].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  });

  const breadcrumb = $derived(
    path.length === 0 ? `${rootLabel} —` : `‹ ${path[path.length - 1]}/`,
  );

  function truncLabel(name: string): string {
    const label = name.replace(/\.html$/, '').replace(/\.md$/, '');
    return label.length > 16 ? label.substring(0, 16) : label;
  }

  function clickItem(item: ArtifactEntry) {
    if (item.type === 'folder') path = [...path, item.name];
    else onFileSelect([...path, item.name].join('/'));
  }
</script>

<div class="panel">
  <button
    class="breadcrumb"
    class:clickable={path.length > 0}
    onclick={() => { if (path.length > 0) path = path.slice(0, -1); }}
  >{breadcrumb}</button>

  <div class="scroll">
    {#if items.length === 0}
      <div class="none">No files found</div>
    {:else}
      {#key path.join('/')}
        <div class="grid">
          {#each items as item, i (item.name)}
            <button class="item" style="animation-delay: {i * 30}ms" onclick={() => clickItem(item)}>
              {#if item.type === 'folder'}
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" class="glow">
                  <path d="M2 5H10L12 7H22V19H2V5Z" stroke="#FAD601" stroke-width="1" fill="none" />
                  <path d="M2 7H22" stroke="#FAD601" stroke-width="1" />
                  <rect x="5" y="10" width="4" height="3" fill="#333" />
                </svg>
              {:else}
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" class="glow">
                  <path d="M5 2H15L20 7V22H5V2Z" fill="#262626" stroke="#FAD601" stroke-width="1" />
                  <path d="M15 2V7H20" fill="#1a1a1a" stroke="#FAD601" stroke-width="1" />
                  <rect x="8" y="10" width="8" height="1" fill="#666" />
                  <rect x="8" y="14" width="8" height="1" fill="#666" />
                  <rect x="8" y="18" width="5" height="1" fill="#666" />
                </svg>
              {/if}
              <span class="label">{truncLabel(item.name)}</span>
            </button>
          {/each}
        </div>
      {/key}
    {/if}
  </div>
</div>

<style>
  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #0c0c0c;
    overflow: hidden;
    font-family: var(--font-ui);
    color: #e5e5e5;
  }
  .breadcrumb {
    padding: 20px 32px 0;
    font-size: 11px;
    letter-spacing: 0.25em;
    color: rgba(255, 255, 255, 0.3);
    font-weight: 300;
    text-transform: uppercase;
    text-align: left;
    background: transparent;
    border: none;
    font-family: inherit;
    cursor: default;
    z-index: 10;
  }
  .breadcrumb.clickable { cursor: pointer; }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 32px 32px 48px;
  }
  .scroll::-webkit-scrollbar { width: 6px; background: #0c0c0c; }
  .scroll::-webkit-scrollbar-track { background-color: transparent; }
  .scroll::-webkit-scrollbar-thumb { background-color: #333; border-radius: 3px; }
  .scroll::-webkit-scrollbar-button { display: none; }
  .none {
    text-align: center;
    color: #666;
    font-size: 14px;
    font-weight: 300;
    padding-top: 100px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    row-gap: 80px;
    column-gap: 32px;
    max-width: 64rem;
    margin: 0 auto;
  }
  .item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0;
    font-family: inherit;
    animation: files-item-enter 0.25s cubic-bezier(0.165, 0.84, 0.44, 1) both;
  }
  @keyframes files-item-enter {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .glow {
    opacity: 0.8;
    transition: opacity 500ms ease, transform 500ms ease;
    animation: screen-icon-glow 3s ease-in-out infinite;
  }
  @keyframes screen-icon-glow {
    0%, 100% { filter: drop-shadow(0 0 2px rgba(250, 214, 1, 0.3)); }
    50% { filter: drop-shadow(0 0 4px rgba(250, 214, 1, 0.5)); }
  }
  .label {
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.4);
    transition: color 300ms ease;
  }
  .item:hover .glow { opacity: 1; transform: scale(1.05); }
  .item:hover .label { color: white; }
</style>
