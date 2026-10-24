import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useOptionalFormStore } from 'form-graph/react';

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
 * The generation form as seen by chrome OUTSIDE it: presets, the self-hosted block, the
 * membership upsell's red handoff. Null when no form is mounted (e.g. the header button
 * outside the sidebar).
 */
export function useGenerationFormBridge(): GenerationFormBridge | null {
  const store = useOptionalFormStore();

  return useMemo(() => {
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
  }, [store]);
}

/** Reactive read of one field's value, or undefined when no form is mounted. */
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
