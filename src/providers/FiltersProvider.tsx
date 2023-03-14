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

type FilterEntityInput = z.infer<typeof filterEntitySchema>;
export type FilterSubTypes = keyof FilterEntityInput;
// TODO - implement model/image/question filters
const filterEntitySchema = z.object({
  model: z
    .object({
      sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
      tags: z.number().array().optional(),
    })
    .default({}),
  post: z
    .object({
      sort: z.nativeEnum(PostSort).default(PostSort.MostReactions),
      tags: z.number().array().optional(),
    })
    .default({}),
  image: z
    .object({
      sort: z.nativeEnum(ImageSort).default(ImageSort.MostReactions),
      tags: z.number().array().optional(),
    })
    .default({}),
  question: z
    .object({
      sort: z.nativeEnum(QuestionSort).default(QuestionSort.Newest),
      tags: z.number().array().optional(),
    })
    .default({}),
});

export type FiltersInput = z.infer<typeof filtersSchema>;
const filtersSchema = filterEntitySchema.extend({
  browsingMode: z.nativeEnum(BrowsingMode).default(BrowsingMode.All),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
});

export const parseFiltersCookie = (cookies: Partial<{ [key: string]: string }>) => {
  const cookieValue = cookies['filters'];
  const parsedFilters = cookieValue ? JSON.parse(decodeURIComponent(cookieValue)) : {};
  return filtersSchema.parse(parsedFilters);
};

type FiltersState = FiltersInput & {
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
    if (!currentUser?.showNsfw) value.browsingMode = BrowsingMode.SFW;
    storeRef.current = createFilterStore({ initialValues: value });
  }

  return <FiltersContext.Provider value={storeRef.current}>{children}</FiltersContext.Provider>;
};

const useSharedFilters = (type: FilterSubTypes) => {
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const period = useFiltersContext((state) => state.period);
  return { browsingMode, period };
};

export const useModelFilters = () => {
  const shared = useSharedFilters('model');
  const sort = useFiltersContext((state) => state.model.sort);
  return { ...shared, sort };
};

export const usePostFilters = () => {
  const shared = useSharedFilters('post');
  const sort = useFiltersContext((state) => state.post.sort);
  return { ...shared, sort };
};

export const useImageFilters = () => {
  const shared = useSharedFilters('image');
  const sort = useFiltersContext((state) => state.image.sort);
  return { ...shared, sort };
};

export const useQuestionFilters = () => {
  const shared = useSharedFilters('question');
  const sort = useFiltersContext((state) => state.question.sort);
  return { ...shared, sort };
};
