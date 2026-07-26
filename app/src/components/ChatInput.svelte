<!-- app/src/components/ChatInput.svelte -->
<script lang="ts">
  let { onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean } = $props();
  let draft = $state('');
  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    draft = '';
  }
</script>

<form class="input" onsubmit={(e) => { e.preventDefault(); submit(); }}>
  <textarea
    bind:value={draft}
    placeholder="Write to Julian…"
    rows="2"
    onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
  ></textarea>
  <button type="submit" {disabled}>Send</button>
</form>

<style>
  .input { display: flex; gap: 0.5rem; padding: 0.75rem; }
  textarea { flex: 1; resize: none; border-radius: 0.5rem; padding: 0.5rem; }
</style>
