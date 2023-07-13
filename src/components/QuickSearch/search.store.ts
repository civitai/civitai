import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { applyQueryMatchers, FilterIdentifier } from '~/components/QuickSearch/util';
type SearchState = {
  rawQuery: string;
  query: string;
  setQuery: (rawQuery: string) => void;
  quickSearchIndex: FilterIdentifier;
  setQuickSearchIndex: (filter: FilterIdentifier) => void;
  filters: Partial<Record<FilterIdentifier, string>>;
  setFilters:
};

export const useSearchStore = create<SearchState>()(
  devtools(
    immer((set, get) => {
      return {
        query: '',
        quickSearchIndex: 'all',
        filters: {},
        setQuery: (rawQuery) => {
          set((state) => {
            state.rawQuery = rawQuery;

            // Check for change to selected quick search index



            const { updatedQuery, matchedFilters: queryMatchedFilters } = applyQueryMatchers(rawQuery, [
              state.quickSearchIndex,
            ]);
            state.updateQuery = updatedQuery;

          });
        },
        setQuickSearchIndex: (filter) => {
          set((state) => {
            state.quickSearchIndex = filter;
          });
        },
      };
    })
  )
);
