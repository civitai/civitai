import { useRef, createContext, useContext } from 'react';
import { MetricTimeframe } from '@prisma/client';
import { SelectMenu } from '~/components/SelectMenu/SelectMenu';
import { useCookies } from '~/providers/CookiesProvider';
import { BrowsingMode, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import { PostsFilterInput } from '~/server/schema/post.schema';
import { setCookie } from '~/utils/cookies-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { createStore, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { devtools } from 'zustand/middleware';
import { QS } from '~/utils/qs';
import { z } from 'zod';

const filterSchema = z.object({
  browsingMode: z.nativeEnum(BrowsingMode).default(BrowsingMode.All),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  model: z.object({
    sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
  }),
  post: z.object({
    sort: z.nativeEnum(PostSort).default(PostSort.MostReactions),
  }),
  image: z.object({
    sort: z.nativeEnum(ImageSort).default(ImageSort.MostReactions),
  }),
});

type FilterProps = {
  filters: PostsFilterInput;
};

type FiltersState = FilterProps & {
  setBrowsingMode: (mode: BrowsingMode) => void;
  setSort: (sort: PostSort) => void;
  setPeriod: (period: MetricTimeframe) => void;
};

type FilterStore = ReturnType<typeof createFilterStore>;

const createFilterStore = ({ initialValues }: { initialValues: PostsFilterInput }) => {
  return createStore<FiltersState>()(
    devtools(
      immer((set, get) => {
        const updateCookie = (data: Partial<PostsFilterInput>) => {
          const state = get();
          const current = Object.entries(state)
            .filter(([, value]) => typeof value !== 'function')
            .reduce<PostsFilterInput>((acc, [key, value]) => ({ ...acc, [key]: value }), {} as any);
          setCookie('filters', JSON.stringify({ ...current, ...data }));
        };

        return {
          filters: { ...initialValues },
          setBrowsingMode: (mode: BrowsingMode) => {
            updateCookie({ browsingMode: mode });
            set((state) => {
              state.filters.browsingMode = mode;
            });
          },
          setSort: (sort: PostSort) => {
            updateCookie({ sort });
            set((state) => {
              state.filters.sort = sort;
            });
          },
          setPeriod: (period: MetricTimeframe) => {
            updateCookie({ period });
            set((state) => {
              state.filters.period = period;
            });
          },
        };
      })
    )
  );
};

const PostsFilterContext = createContext<FilterStore | null>(null);
export function usePostsFilterContext<T>(selector: (state: FiltersState) => T) {
  const store = useContext(PostsFilterContext);
  if (!store) throw new Error('Missing PostsFilterCtx.Provider in the tree');
  return useStore(store, selector);
}

export const PostsFilterProvider = ({ children }: { children: React.ReactNode }) => {
  const cookies = useCookies().post;
  const storeRef = useRef<FilterStore>();

  if (!storeRef.current) {
    storeRef.current = createFilterStore({ initialValues: cookies });
  }

  return (
    <PostsFilterContext.Provider value={storeRef.current}>{children}</PostsFilterContext.Provider>
  );
};

const periodOptions = Object.values(MetricTimeframe);
export function PostsPeriod() {
  const period = usePostsFilterContext((state) => state.filters.period);
  const setPeriod = usePostsFilterContext((state) => state.setPeriod);
  return (
    <SelectMenu
      label={period && splitUppercase(period.toString())}
      options={periodOptions.map((option) => ({ label: splitUppercase(option), value: option }))}
      onClick={(period) => setPeriod(period)}
      value={period}
    />
  );
}

const sortOptions = Object.values(PostSort);
export function PostsSort() {
  const sort = usePostsFilterContext((state) => state.filters.sort);
  const setSort = usePostsFilterContext((state) => state.setSort);

  return (
    <SelectMenu
      label={sort}
      options={sortOptions.map((x) => ({ label: x, value: x }))}
      onClick={(sort) => setSort(sort)}
      value={sort}
    />
  );
}
