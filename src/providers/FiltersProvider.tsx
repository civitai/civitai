import { useRef, createContext, useContext } from 'react';
import { MetricTimeframe } from '@prisma/client';
import { BrowsingMode, ImageSort, ModelSort, PostSort, QuestionSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { createStore, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { z } from 'zod';
import merge from 'lodash/merge';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export type FiltersInput = z.infer<typeof filtersSchema>;
/** all values should either have a default or be optional */
const filtersSchema = z.object({
  browsingMode: z.nativeEnum(BrowsingMode).default(BrowsingMode.All),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  model: z
    .object({
      sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
    })
    .default({}),
  post: z
    .object({
      sort: z.nativeEnum(PostSort).default(PostSort.MostReactions),
      test: z.boolean().default(true),
    })
    .default({}),
  image: z
    .object({
      sort: z.nativeEnum(ImageSort).default(ImageSort.MostReactions),
    })
    .default({}),
  question: z
    .object({
      sort: z.nativeEnum(QuestionSort).default(QuestionSort.Newest),
    })
    .default({}),
});

export const parseFiltersCookie = (cookies: Partial<{ [key: string]: string }>) => {
  const cookieValue = cookies['filters'];
  const parsedFilters = cookieValue ? JSON.parse(decodeURIComponent(cookieValue)) : {};
  return filtersSchema.parse(parsedFilters);
};

type FilterProps = FiltersInput;

type FiltersState = FilterProps & {
  setFilters: (filters: DeepPartial<FiltersInput>) => void;
};

type FilterStore = ReturnType<typeof createFilterStore>;

const createFilterStore = ({ initialValues }: { initialValues: FiltersInput }) => {
  return createStore<FiltersState>()(
    devtools((set, get) => {
      return {
        ...initialValues,
        setFilters(filters) {
          set((state) => {
            const updatedFilters = merge(state, filters);
            setCookie('filters', updatedFilters);
            return { ...updatedFilters };
          });
        },
      };
    })
  );
};

const FiltersContext = createContext<FilterStore | null>(null);
export function useFiltersContext<T>(selector: (state: FiltersState) => T) {
  const store = useContext(FiltersContext);
  if (!store) throw new Error('Missing PostsFilterCtx.Provider in the tree');
  return useStore(store, selector);
}

export const FiltersProvider = ({
  children,
  value,
}: {
  children: React.ReactNode;
  value: FiltersInput;
}) => {
  const currentUser = useCurrentUser();
  const storeRef = useRef<FilterStore>();
  if (!storeRef.current) {
    storeRef.current = createFilterStore({ initialValues: value });
  }

  return <FiltersContext.Provider value={storeRef.current}>{children}</FiltersContext.Provider>;
};
