import { useRef, createContext, useContext, useEffect } from 'react';
import { ImageGenerationProcess, MetricTimeframe } from '@prisma/client';
import { BrowsingMode, ImageSort, ModelSort, PostSort, QuestionSort } from '~/server/common/enums';
import { setCookie } from '~/utils/cookies-helpers';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
// import { immer } from 'zustand/middleware/immer';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { mergeWith, isArray } from 'lodash-es';

export const modelFilterSchema = z
  .object({
    sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
    tags: z.number().array().nullish(),
  })
  .default({});

export const postFilterSchema = z
  .object({
    sort: z.nativeEnum(PostSort).default(PostSort.MostReactions),
    tags: z.number().array().nullish(),
  })
  .default({});

export const imageFilterSchema = z
  .object({
    sort: z.nativeEnum(ImageSort).default(ImageSort.MostReactions),
    tags: z.number().array().nullish(),
    generation: z.nativeEnum(ImageGenerationProcess).array().nullish(),
    excludedTags: z.number().array().nullish(),
  })
  .default({});

export const questionFilterSchema = z
  .object({
    sort: z.nativeEnum(QuestionSort).default(QuestionSort.Newest),
    tags: z.number().array().nullish(),
  })
  .default({});

type FilterEntityInput = z.infer<typeof filterEntitySchema>;
export type FilterSubTypes = keyof FilterEntityInput;
const filterEntitySchema = z.object({
  model: modelFilterSchema,
  post: postFilterSchema,
  image: imageFilterSchema,
  question: questionFilterSchema,
});

export type FiltersInput = z.infer<typeof filtersSchema>;
const filtersSchema = filterEntitySchema.extend({
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
});

export const parseFiltersCookie = (cookies: Partial<{ [key: string]: string }>) => {
  const cookieValue = cookies['filters'];
  const parsedFilters = cookieValue ? JSON.parse(decodeURIComponent(cookieValue)) : {};
  const result = filtersSchema.safeParse(parsedFilters);
  if (result.success) return result.data;
  else return filtersSchema.parse({});
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
            const updatedFilters = filtersSchema.parse(mergeWith(state, filters, customizer));
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
    else value.browsingMode = BrowsingMode.NSFW;
    storeRef.current = createFilterStore({ initialValues: value });
  }

  return <FiltersContext.Provider value={storeRef.current}>{children}</FiltersContext.Provider>;
};

const useSharedFilters = (type: FilterSubTypes) => {
  const period = useFiltersContext((state) => state.period);
  return { period };
};

export const useModelFilters = () => {
  const shared = useSharedFilters('model');
  const sort = useFiltersContext((state) => state.model.sort);
  return { ...shared, sort };
};

export const usePostFilters = () => {
  const shared = useSharedFilters('post');
  const sort = useFiltersContext((state) => state.post.sort);
  const tags = useFiltersContext((state) => state.post.tags);
  return { ...shared, sort, tags };
};

export const useImageFilters = () => {
  const shared = useSharedFilters('image');
  const sort = useFiltersContext((state) => state.image.sort);
  const tags = useFiltersContext((state) => state.image.tags);
  const excludedTags = useFiltersContext((state) => state.image.excludedTags);
  const generation = useFiltersContext((state) => state.image.generation);
  return { ...shared, sort, tags, excludedTags, generation };
};

export const useQuestionFilters = () => {
  const shared = useSharedFilters('question');
  const sort = useFiltersContext((state) => state.question.sort);
  return { ...shared, sort };
};

// #region [merge logic]
// issue with undefined values here: https://github.com/lodash/lodash/blob/2da024c3b4f9947a48517639de7560457cd4ec6c/.internal/assignMergeValue.js#L14
const customizer = (objValue: unknown, srcValue: unknown) => {
  // console.log({ objValue, srcValue });
  if (isArray(objValue)) {
    return srcValue;
  }
};
// #endregion
