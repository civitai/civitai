import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useField, useOptionalFormStore } from 'form-graph/react';
import { DataGraphContext } from '~/libs/data-graph/react/DataGraphProvider';
import type { SnippetsNodeValue } from '~/shared/data-graph/generation/common';

export type SnippetsGraphHandle = {
  /** Reactive `snippets` value — undefined when the active branch has none. */
  snippets: SnippetsNodeValue | undefined;
  /** Click-time snapshot of every resolved value, keyed by field. */
  getState(): Record<string, unknown>;
  setSnippets(next: SnippetsNodeValue): void;
};

/**
 * The snippets feature's view of "the form", working under EITHER lane:
 * v1's DataGraphProvider or a form-graph FormProvider — the editors and
 * wildcard components are shared between GenerationFormV2 and the
 * form-graph forms, so they cannot assume one provider. Dies with the v1
 * lane: once data-graph is deleted this collapses to the form-graph half.
 */
export function useSnippetsGraph(): SnippetsGraphHandle {
  const v1Graph = useContext(DataGraphContext);
  const store = useOptionalFormStore();

  const subscribeV1 = useCallback(
    (cb: () => void) => (v1Graph ? v1Graph.subscribe('snippets', cb) : () => undefined),
    [v1Graph]
  );
  const getV1Snapshot = useCallback(
    () => (v1Graph?.hasNode('snippets') ? v1Graph.getSnapshot('snippets') : null),
    [v1Graph]
  );
  const v1Snapshot = useSyncExternalStore(subscribeV1, getV1Snapshot, getV1Snapshot);

  const field = useField(store, 'snippets');

  const snippets = (v1Graph ? v1Snapshot?.value : field?.value) as SnippetsNodeValue | undefined;

  return useMemo(
    () => ({
      snippets,
      getState: () =>
        v1Graph
          ? (v1Graph.getSnapshot() as Record<string, unknown>)
          : ((store?.getSnapshot().state ?? {}) as Record<string, unknown>),
      setSnippets: (next) => {
        if (v1Graph) v1Graph.set({ snippets: next } as Parameters<typeof v1Graph.set>[0]);
        else store?.set({ snippets: next });
      },
    }),
    [snippets, v1Graph, store]
  );
}
