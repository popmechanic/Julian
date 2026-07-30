<!-- app/src/components/ChatInput.svelte -->
<script lang="ts">
  let { onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean } = $props();

  const MIN_H = 50;
  const MAX_H = 200;
  let draft = $state('');
  let area: HTMLTextAreaElement | undefined = $state();
  let prevHeight = MIN_H;

  function adjustHeight() {
    const el = area;
    if (!el) return;
    el.style.transition = 'none';
    el.style.height = 'auto';
    const target = Math.min(Math.max(el.scrollHeight, MIN_H), MAX_H);
    el.style.height = `${prevHeight}px`;
    void el.offsetHeight; // reflow, then animate to target
    el.style.transition = 'height 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    el.style.height = `${target}px`;
    el.style.overflowY = target >= MAX_H ? 'auto' : 'hidden';
    prevHeight = target;
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    draft = '';
    if (area) {
      area.style.height = `${MIN_H}px`;
      area.style.overflowY = 'hidden';
      prevHeight = MIN_H;
    }
  }

  $effect(() => { if (!disabled) area?.focus(); });
</script>

<div class="input">
  <textarea
    bind:this={area}
    bind:value={draft}
    oninput={adjustHeight}
    onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
    placeholder={disabled ? 'PROCESSING...' : 'INPUT BUFFER...'}
    {disabled}
    spellcheck="false"
    autocomplete="off"
    rows="1"
  ></textarea>
  <button class="send" onclick={submit} {disabled} aria-label="Send message">A</button>
</div>

<style>
  .input { display: flex; align-items: flex-end; gap: 12px; padding: 12px 0; }
  textarea {
    flex: 1;
    background-color: var(--j-yellow-key);
    box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15), inset -1px -1px 2px rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #000;
    font-weight: bold;
    padding: 12px 16px;
    height: 50px;
    font-family: var(--font-terminal);
    text-transform: uppercase;
    font-size: 1.1rem;
    line-height: 1.4;
    border: none;
    outline: none;
    resize: none;
    overflow-y: hidden;
  }
  textarea:disabled { opacity: 0.5; }
  textarea::placeholder { color: rgba(0, 0, 0, 0.55); }
  .send {
    width: 60px;
    height: 60px;
    border-radius: 50%;
    background: #e5e5e5;
    color: var(--j-gray-333);
    border: 1px solid var(--j-gray-999);
    box-shadow: 0 4px 0 var(--j-gray-999), 0 8px 10px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-terminal);
    font-size: 0.9rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    cursor: pointer;
    transition: background-color 100ms ease, box-shadow 100ms ease;
    flex-shrink: 0;
  }
  .send:active { transform: translateY(4px); box-shadow: 0 0 0 var(--j-gray-999), inset 0 2px 5px rgba(0, 0, 0, 0.1); }
  .send:disabled { background: var(--j-gray-555); box-shadow: none; cursor: not-allowed; }
  @media (prefers-reduced-motion: reduce) { textarea { transition: none !important; } }
</style>
