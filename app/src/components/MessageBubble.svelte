<!-- app/src/components/MessageBubble.svelte -->
<script module lang="ts">
  // Annex rows carry the web-app siblings' names (Lumen, Sable, Iris…); live rows are always Julian.
  export function displayName(role: string, speakerName: string): string | null {
    return role === 'assistant' && speakerName && speakerName !== 'Julian' ? speakerName : null;
  }

  // Audio links in a message (Julian's voice renders land at /api/artifacts/voice/out/<name>.wav)
  // become an inline player, so a phone hears the voice instead of reading a URL.
  const AUDIO_URL = /(?:https?:\/\/[^\s<>()*]+|(?<![\w/])\/api\/artifacts\/[^\s<>()*]+)\.(?:wav|mp3|m4a|ogg)\b/gi;
  export function audioUrls(text: string): string[] {
    return Array.from(new Set(text.match(AUDIO_URL) ?? []));
  }
</script>

<script lang="ts">
  let { role, speakerName, text, ts }: { role: string; speakerName: string; text: string; ts: number } = $props();
  const time = $derived(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
</script>

<div class="line {role} message-enter" title="{speakerName} · {time}">
  <span class="prefix">{role === 'user' ? '// ' : '> '}</span>{#if displayName(role, speakerName)}<span class="who">{displayName(role, speakerName)}: </span>{/if}<span class="text">{text}</span>
  {#each audioUrls(text) as src (src)}
    <audio class="voice" controls preload="metadata" {src}></audio>
  {/each}
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
  .voice { display: block; width: 100%; max-width: 420px; margin: 8px 0 2px; }
</style>
