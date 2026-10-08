import { useMemo } from 'react';
import { useField, useOptionalFormStore } from 'form-graph/react';
import type { SnippetsNodeValue } from '~/shared/generation/values';

export type SnippetsFormHandle = {
  /** Reactive `snippets` value — undefined when the active branch has none. */
  snippets: SnippetsNodeValue | undefined;
  /** Click-time snapshot of every resolved value, keyed by field. */
  getState(): Record<string, unknown>;
  setSnippets(next: SnippetsNodeValue): void;
};

export function useSnippetsForm(): SnippetsFormHandle {
  const store = useOptionalFormStore();
  const field = useField(store, 'snippets');
  const snippets = field?.value as SnippetsNodeValue | undefined;

  return useMemo(
    () => ({
      snippets,
      getState: () => (store?.getSnapshot().state ?? {}) as Record<string, unknown>,
      setSnippets: (next) => store?.set({ snippets: next }),
    }),
    [snippets, store]
  );
}
