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
    font-size: 0.75rem;
    opacity: 0.75;
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #888;
  }
  .synced .dot {
    background: #4a4;
  }
  .connecting .dot {
    background: #aa4;
  }
  .offline .dot {
    background: #a44;
  }
</style>
