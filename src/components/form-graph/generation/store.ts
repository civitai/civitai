import { useSyncExternalStore } from 'react';
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
