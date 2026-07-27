<!-- app/src/components/ChatView.svelte -->
<script module lang="ts">
  export function presenceFor(
    sessionActive: boolean,
    messageCount: number,
  ): { divider: boolean; buttonLabel: string | null } {
    if (sessionActive) return { divider: false, buttonLabel: null };
    return { divider: messageCount > 0, buttonLabel: 'WAKE JULIAN' };
  }
</script>

<script lang="ts">
  import { store } from '../lib/store';
  import type { MessageRow } from '../lib/store';
  import { useSortedMessages } from '../lib/tiny.svelte';
  import { sendMessage } from '../lib/api';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let { processing = false, sessionActive = false, onStart = () => {} }: {
    processing?: boolean; sessionActive?: boolean; onStart?: () => void;
  } = $props();

  const messages = useSortedMessages();
  const presence = $derived(presenceFor(sessionActive, messages.ids.length));
  let scroller: HTMLElement | undefined = $state();
  $effect(() => { messages.ids; scroller?.scrollTo({ top: scroller.scrollHeight }); });

  function rowOf(id: string) {
    return store.getRow('messages', id) as unknown as MessageRow;
  }
</script>

<section class="chat">
  <div class="messages-panel">
    <div class="scanlines"></div>
    <div class="messages" bind:this={scroller}>
      {#each messages.ids as id (id)}
        {@const m = rowOf(id)}
        <MessageBubble role={m.role} speakerName={m.speakerName} text={m.text} ts={m.ts} />
      {/each}
      {#if processing}
        <div class="thinking">
          <span>&gt; PROCESSING</span>
          <span class="dots">
            <span class="dot"></span>
            <span class="dot d2"></span>
            <span class="dot d3"></span>
          </span>
        </div>
      {/if}
      {#if presence.divider}
        <div class="asleep-divider">— julian is asleep · the conversation above is remembered, not live —</div>
      {/if}
    </div>
  </div>
  <div class="input-footer">
    {#if !sessionActive}
      <div class="start-wrap">
        <button class="start" onclick={onStart}>{presence.buttonLabel}</button>
      </div>
    {:else}
      <ChatInput onSend={(t) => sendMessage(t)} disabled={processing} />
    {/if}
  </div>
</section>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .messages-panel {
    flex: 1;
    position: relative;
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-top: none;
    border-bottom: none;
    min-height: 0;
    display: flex;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    scroll-behavior: smooth;
    padding: 16px;
    position: relative;
    z-index: 1;
  }
  .thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    color: var(--j-yellow);
    font-size: 1.1rem;
    font-family: var(--font-terminal);
  }
  .dots { display: flex; gap: 4px; margin-left: 4px; }
  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    background: var(--j-yellow);
    animation: thinking-pulse 1.2s ease-in-out infinite;
  }
  .dot.d2 { animation-delay: 0.2s; }
  .dot.d3 { animation-delay: 0.4s; }
  .asleep-divider {
    text-align: center;
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--j-gray-555);
    padding: 14px 8px 6px;
    user-select: none;
  }
  .input-footer {
    background: var(--j-crt-2);
    border: 4px solid var(--j-bezel);
    border-top: 1px dashed var(--j-gray-333);
    border-radius: 0 0 12px 12px;
    padding: 0 16px;
    box-shadow: inset 0 -2px 10px rgba(0, 0, 0, 0.5);
    flex-shrink: 0;
  }
  .start-wrap { padding: 12px 0; text-align: center; }
  .start {
    padding: 10px 24px;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    background: var(--j-yellow);
    color: #000;
    border: 2px solid #000;
    border-radius: 4px;
    cursor: pointer;
    box-shadow: 3px 3px 0 #000;
  }
</style>
