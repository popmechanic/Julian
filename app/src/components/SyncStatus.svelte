<!-- app/src/components/SyncStatus.svelte -->
<!-- Dot + label reflecting the stream sync phase (Task 6's syncPhase/onSyncPhase). -->
<script lang="ts">
  import { syncPhase, onSyncPhase } from '../lib/store';

  let phase = $state(syncPhase());

  $effect(() => onSyncPhase((p) => (phase = p)));

  const labels = {
    idle: 'local',
    connecting: 'connecting',
    synced: 'synced',
    offline: 'offline',
  } as const;
</script>

<span class="status {phase}" title={`stream: ${labels[phase]}`}>
  <span class="dot"></span>{labels[phase]}
</span>

<style>
  .status {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-family: var(--font-terminal);
    font-size: 0.85rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.5);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--j-gray-666); }
  .synced .dot { background: var(--j-green); box-shadow: 0 0 6px var(--j-green); }
  .connecting .dot { background: var(--j-yellow); animation: pulse-warn 2s ease-in-out infinite; }
  .offline .dot { background: var(--j-red); }
</style>
