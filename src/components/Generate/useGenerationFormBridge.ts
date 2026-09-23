import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useOptionalFormStore } from 'form-graph/react';
import { DataGraphContext } from '~/libs/data-graph/react/DataGraphProvider';

export type GenerationFormBridge = {
  /** Snapshot of every resolved value, keyed by field. */
  getState(): Record<string, unknown>;
  set(patch: Record<string, unknown>): void;
  /** Derived (computed) keys in the active branch. */
  getComputedKeys(): string[];
  subscribe(cb: () => void): () => void;
  subscribeKey(key: string, cb: () => void): () => void;
};

/**
 * The generation form as seen by chrome that is SHARED between the two form
 * lanes (v1 DataGraphProvider, form-graph FormProvider): presets, the
 * self-hosted block, the membership upsell's red handoff. Both stores expose
 * the same five operations; this picks whichever provider is mounted. Null
 * when neither is (e.g. the header button outside the sidebar). Dies with
 * the v1 lane — see also `useSnippetsGraph`, its field-level sibling.
 */
export function useGenerationFormBridge(): GenerationFormBridge | null {
  const v1Graph = useContext(DataGraphContext);
  const store = useOptionalFormStore();

  return useMemo(() => {
    if (v1Graph) {
      return {
        getState: () => v1Graph.getSnapshot() as Record<string, unknown>,
        set: (patch) => v1Graph.set(patch as Parameters<typeof v1Graph.set>[0]),
        getComputedKeys: () => v1Graph.getComputedKeys(),
        subscribe: (cb) => v1Graph.subscribe(cb),
        subscribeKey: (key, cb) => v1Graph.subscribe(key, cb),
      };
    }
    if (store) {
      return {
        getState: () => store.getSnapshot().state as Record<string, unknown>,
        set: (patch) => store.set(patch),
        getComputedKeys: () => store.getComputedKeys(),
        subscribe: (cb) => store.subscribe(cb),
        subscribeKey: (key, cb) => store.subscribe(key, cb),
      };
    }
    return null;
  }, [v1Graph, store]);
}

/** Reactive read of one field's value through whichever lane is mounted. */
export function useGenerationFormValue<T = unknown>(key: string): T | undefined {
  const bridge = useGenerationFormBridge();
  const subscribe = useCallback(
    (cb: () => void) => (bridge ? bridge.subscribeKey(key, cb) : () => undefined),
    [bridge, key]
  );
  const getValue = useCallback(
    () => (bridge ? (bridge.getState()[key] as T | undefined) : undefined),
    [bridge, key]
  );
  return useSyncExternalStore(subscribe, getValue, getValue);
}
