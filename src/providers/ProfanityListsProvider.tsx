import { createContext, useContext, useMemo } from 'react';
import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import blockedWordsBootstrap from '~/utils/metadata/lists/blocked-words.json';
import displayBootstrap from '~/utils/metadata/lists/profanity-display.json';
import { trpc } from '~/utils/trpc';

export type ProfanityListKind = 'display' | 'search';

interface ProfanityFiltersContextValue {
  filters: Record<ProfanityListKind, SimpleProfanityFilter>;
}

const BOOTSTRAP_LISTS: Record<ProfanityListKind, string[]> = {
  display: displayBootstrap,
  search: blockedWordsBootstrap,
};

// Build bootstrap filters once at module load so the initial render is
// synchronous (no flash of uncensored content, no per-instance trie build).
const BOOTSTRAP_FILTERS: Record<ProfanityListKind, SimpleProfanityFilter> = {
  display: createProfanityFilter({ blockedWords: BOOTSTRAP_LISTS.display }),
  search: createProfanityFilter({ blockedWords: BOOTSTRAP_LISTS.search }),
};

const ProfanityFiltersContext = createContext<ProfanityFiltersContextValue>({
  filters: BOOTSTRAP_FILTERS,
});

export const useProfanityFilters = () => useContext(ProfanityFiltersContext);

export const useProfanityFilter = (kind: ProfanityListKind): SimpleProfanityFilter =>
  useProfanityFilters().filters[kind];

export const ProfanityListsProvider = ({ children }: { children: React.ReactNode }) => {
  // Keep the bundled filters available immediately; the dynamic KV-backed list
  // arrives in the background and replaces them once it resolves.
  const { data } = trpc.system.getProfanityLists.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
    cacheTime: 1000 * 60 * 60 * 24,
  });

  const value = useMemo<ProfanityFiltersContextValue>(() => {
    if (!data) return { filters: BOOTSTRAP_FILTERS };
    return {
      filters: {
        display: createProfanityFilter({ blockedWords: data.display }),
        search: createProfanityFilter({ blockedWords: data.search }),
      },
    };
  }, [data]);

  return (
    <ProfanityFiltersContext.Provider value={value}>{children}</ProfanityFiltersContext.Provider>
  );
};
