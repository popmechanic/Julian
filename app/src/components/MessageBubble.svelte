<!-- app/src/components/MessageBubble.svelte -->
<script module lang="ts">
  // Annex rows carry the web-app siblings' names (Lumen, Sable, Iris…); live rows are always Julian.
  export function displayName(role: string, speakerName: string): string | null {
    return role === 'assistant' && speakerName && speakerName !== 'Julian' ? speakerName : null;
  }
</script>

<script lang="ts">
  let { role, speakerName, text, ts }: { role: string; speakerName: string; text: string; ts: number } = $props();
  const time = $derived(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
</script>

<div class="line {role} message-enter" title="{speakerName} · {time}">
  <span class="prefix">{role === 'user' ? '// ' : '> '}</span>{#if displayName(role, speakerName)}<span class="who">{displayName(role, speakerName)}: </span>{/if}<span class="text">{text}</span>
</div>

<style>
  .line {
    padding: 4px 0;
    font-family: var(--font-terminal);
    font-size: 1.1rem;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .line.assistant { color: var(--j-yellow); text-shadow: 0 0 4px rgba(0, 0, 0, 0.3); }
  .line.assistant .prefix { color: var(--j-yellow); }
  .line.user { color: #fff; opacity: 0.8; }
  .line.user .prefix { color: var(--j-gray-666); }
  .who { color: var(--j-yellow); opacity: 0.75; }
</style>
