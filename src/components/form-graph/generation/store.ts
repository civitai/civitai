import { useMemo, useSyncExternalStore } from 'react';
import {
  selectedResourceIds,
  type SelectedResources,
} from '~/components/Generate/paid-access-gate';
import type { generationHub } from '~/shared/form-graph/generation/hub.graph';

export type GenerationStore = ReturnType<(typeof generationHub)['createStore']>;

/** The store's active field keys, in declaration order. */
export function useActiveKeys(store: GenerationStore): readonly string[] {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getSnapshot().keys,
    () => store.getSnapshot().keys
  );
}

export function useOutputType(store: GenerationStore): 'image' | 'video' | 'audio' | 'model3d' {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => (store.getSnapshot().state as { output?: string }).output as 'image',
    () => (store.getSnapshot().state as { output?: string }).output as 'image'
  );
}

/** The form's values as one string, so two moments of the form compare by value. */
export function formStateKey(store: GenerationStore): string {
  return JSON.stringify(store.getSnapshot().state);
}

export function useFormStateKey(store: GenerationStore): string {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => formStateKey(store),
    () => formStateKey(store)
  );
}

export function useSelectedResourceIds(store: GenerationStore): number[] {
  // Joined so the snapshot is a primitive: an array would be a new reference on every read.
  const key = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => selectedResourceIds(store.getSnapshot().state as SelectedResources).join(','),
    () => selectedResourceIds(store.getSnapshot().state as SelectedResources).join(',')
  );
  return useMemo(() => (key ? key.split(',').map(Number) : []), [key]);
}
