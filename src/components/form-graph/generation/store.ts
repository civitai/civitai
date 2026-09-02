import { useSyncExternalStore } from 'react';
import type { FormStore } from 'form-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GenerationStore = FormStore<any, GenerationCtx>;

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
