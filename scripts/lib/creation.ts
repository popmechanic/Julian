import type { MergeableStore } from 'tinybase/mergeable-store';
import { newLedgerId, SCHEMA_VERSION } from 'julian-shared/schema';

export interface CreationRecord {
  ledgerId: string;
  parentLedgerId: string;
  createdAt: number;
  createdBy: string;
}

const PARENT = 'fireproof:julian-chat-v14';
const LINEAGE_NOTE =
  'Successor to the condemned Fireproof ledger julian-chat-v14 (Feb–Jul 2026). ' +
  'The parent lineage rests in the verified archives at ~/julian-stream-backups/ ' +
  '(two Fireproof archives + key escrow). Fresh store, lineage only — decision D3, ' +
  'spec 2026-07-26. Constraint 1 of dream 0006: identity and lineage from the first write.';

export function performCreation(store: MergeableStore, opts: { now?: number } = {}): CreationRecord {
  if (store.getValue('ledgerId')) {
    throw new Error('Store already has a ledgerId — creation happens once, ever.');
  }
  const createdAt = opts.now ?? Date.now();
  const ledgerId = newLedgerId(createdAt);
  store.setValues({
    ledgerId,
    parentLedgerId: PARENT,
    lineageNote: LINEAGE_NOTE,
    createdAt,
    createdBy: 'Julian & Marcus',
    storeSchemaVersion: SCHEMA_VERSION,
    activeSessionId: '',
  });
  return { ledgerId, parentLedgerId: PARENT, createdAt, createdBy: 'Julian & Marcus' };
}
