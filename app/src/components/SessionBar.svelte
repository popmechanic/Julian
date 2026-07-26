<!-- app/src/components/SessionBar.svelte -->
<!-- Session start/end controls. Callers wire onStart/onEnd to the -->
<!-- startSession/endSession API calls (Task 7's client). -->
<script lang="ts">
  let { sessionActive, onStart, onEnd }: { sessionActive: boolean; onStart: () => void; onEnd: () => void } =
    $props();
</script>

<header class="bar">
  <span class="name">Julian</span>
  {#if sessionActive}
    <button onclick={onEnd}>End session</button>
  {:else}
    <button class="primary" onclick={onStart}>Wake Julian</button>
  {/if}
</header>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border, #333);
  }
  .name {
    font-weight: 600;
    margin-right: auto;
  }
  .primary {
    font-weight: 600;
  }
</style>
