<!-- app/src/components/SyncStatus.svelte -->
<!-- Dot + label reflecting the stream sync phase (Task 6's syncPhase/onSyncPhase). -->
<script module lang="ts">
  const labels = {
    idle: 'local',
    connecting: 'connecting',
    synced: 'synced',
    offline: 'offline',
    revoked: 'access revoked — a standing act is needed',
    stale: 'reload for the new Julian',
  } as const;

  export function pillTitle(phase: string, count: number): string {
    return `stream: ${labels[phase as keyof typeof labels] ?? phase} · ${count} rows`;
  }
</script>

<script lang="ts">
  import { store, syncPhase, onSyncPhase } from '../lib/store';

  let phase = $state(syncPhase());
  let count = $state(store.getRowIds('messages').length);

  $effect(() => onSyncPhase((p) => (phase = p)));

  $effect(() => {
    const id = store.addRowIdsListener('messages', () => (count = store.getRowIds('messages').length));
    return () => store.delListener(id);
  });
</script>

<span class="status {phase}" title={pillTitle(phase, count)}>
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
  /* revoked: amber, but off — no glow, no pulse. A standing act is needed, not a retry. */
  .revoked .dot { background: var(--j-yellow); opacity: 0.5; }
  .stale .dot { background: var(--j-gray-666); }
</style>
