// Rune wrappers over TinyBase listeners — Svelte 5 runes mode.
import { store } from './store';

export function useSortedMessages() {
  let ids = $state<string[]>(store.getSortedRowIds('messages', 'ts'));
  $effect(() => {
    const listenerId = store.addSortedRowIdsListener(
      'messages',
      'ts',
      false,
      0,
      undefined,
      (_store, _tableId, _cellId, _descending, _offset, _limit, sortedRowIds) => {
        ids = [...sortedRowIds];
      },
    );
    return () => store.delListener(listenerId);
  });
  return {
    get ids() {
      return ids;
    },
  };
}

export function useValue(valueId: string) {
  let value = $state(store.getValue(valueId));
  $effect(() => {
    const listenerId = store.addValueListener(valueId, () => {
      value = store.getValue(valueId);
    });
    return () => store.delListener(listenerId);
  });
  return {
    get value() {
      return value;
    },
  };
}
