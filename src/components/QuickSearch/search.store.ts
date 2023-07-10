import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { FilterIndex } from '~/components/QuickSearch/util';
type SearchState = {
  query: string;
  setQuery: (dispatch: string | ((query: string) => string)) => void;
  quickSearchFilter: FilterIndex | 'all';
  setQuickSearchFilter: (filter: FilterIndex | 'all') => void;
};

export const useSearchStore = create<SearchState>()(
  devtools(
    immer((set, get) => {
      return {
        query: '',
        quickSearchFilter: 'all',
        setQuery: (dispatch) => {
          set((state) => {
            const query = get().query;
            state.query = typeof dispatch === 'function' ? dispatch(query) : dispatch;
          });
        },
        setQuickSearchFilter: (filter) => {
          set((state) => {
            state.quickSearchFilter = filter;
          });
        },
      };
    })
  )
);
