import { onMount, untrack } from 'svelte';
import {
  ChangesState,
  changesStorageKey,
  type ChangesFields,
  type CurrentPrompts,
} from './changes';

export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function createChanges(moderatorId: number): ChangesState {
  const fields = $state<ChangesFields>({ changes: {}, current: null });
  return new ChangesState(fields, browserStorage(), changesStorageKey(moderatorId));
}

/**
 * The drafts, kept in step with the page: restored once in the browser (so server and client render
 * the same first frame), reloaded when another tab saves, and pruned when a reload makes a draft live.
 * Call during component initialisation.
 */
export function createChangesSync(
  moderatorId: number,
  current: () => CurrentPrompts | null
): ChangesState {
  const changes = createChanges(moderatorId);
  let mounted = $state(false);
  onMount(() => {
    changes.restore(current());
    mounted = true;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === changesStorageKey(moderatorId)) changes.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });
  $effect(() => {
    const next = current();
    if (mounted) untrack(() => changes.setCurrent(next));
  });
  return changes;
}
