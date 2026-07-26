<!-- app/src/components/ChatView.svelte -->
<script lang="ts">
  import { store } from '../lib/store';
  import type { MessageRow } from '../lib/store';
  import { useSortedMessages } from '../lib/tiny.svelte';
  import { sendMessage } from '../lib/api';
  import MessageBubble from './MessageBubble.svelte';
  import ChatInput from './ChatInput.svelte';

  let { processing = false }: { processing?: boolean } = $props();
  const messages = useSortedMessages();
  let scroller: HTMLElement | undefined = $state();
  $effect(() => { messages.ids; scroller?.scrollTo({ top: scroller.scrollHeight }); });

  function rowOf(id: string) {
    return store.getRow('messages', id) as unknown as MessageRow;
  }
</script>

<section class="chat">
  <div class="messages" bind:this={scroller}>
    {#each messages.ids as id (id)}
      {@const m = rowOf(id)}
      <MessageBubble role={m.role} speakerName={m.speakerName} text={m.text} ts={m.ts} />
    {/each}
    {#if processing}<div class="thinking">Julian is thinking…</div>{/if}
  </div>
  <ChatInput onSend={(t) => sendMessage(t)} disabled={processing} />
</section>

<style>
  .chat { display: flex; flex-direction: column; height: 100%; }
  .messages { flex: 1; overflow-y: auto; padding: 1rem; }
  .thinking { opacity: 0.5; font-style: italic; padding: 0.5rem 1rem; }
</style>
