<!-- app/src/components/MessageBubble.svelte -->
<script lang="ts">
  let { role, speakerName, text, ts }: { role: string; speakerName: string; text: string; ts: number } = $props();
  const time = $derived(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
</script>

<div class="bubble {role}">
  <div class="meta"><span class="speaker">{speakerName}</span><span class="time">{time}</span></div>
  <div class="text">{text}</div>
</div>

<style>
  .bubble { max-width: 44rem; margin: 0.5rem 0; padding: 0.75rem 1rem; border-radius: 0.75rem; }
  .bubble.user { margin-left: auto; background: var(--bubble-user, #2a2a2e); }
  .bubble.assistant { margin-right: auto; background: var(--bubble-julian, #1e2430); }
  .meta { display: flex; gap: 0.5rem; font-size: 0.75rem; opacity: 0.6; margin-bottom: 0.25rem; }
  .text { white-space: pre-wrap; line-height: 1.5; }
</style>
