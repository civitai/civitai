import {
  CheckpointType,
  ImageGenerationProcess,
  MediaType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
} from '@prisma/client';
import { createContext, useCallback, useContext, useRef } from 'react';
import { z } from 'zod';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { constants } from '~/server/common/constants';
import {
  ArticleSort,
  BountySort,
  BountyStatus,
  ClubSort,
  CollectionSort,
  ImageSort,
  ModelSort,
  PostSort,
  QuestionSort,
  QuestionStatus,
  ThreadSort,
  MarkerType,
} from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { getInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { getInfiniteClubSchema } from '~/server/schema/club.schema';

export type ModelFilterSchema = z.infer<typeof modelFilterSchema>;
const modelFilterSchema = z.object({
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.Month),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(ModelSort).default(ModelSort.HighestRated),
  types: z.nativeEnum(ModelType).array().optional(),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
  status: z.nativeEnum(ModelStatus).array().optional(),
  earlyAccess: z.boolean().optional(),
  supportsGeneration: z.boolean().optional(),
  fromPlatform: z.boolean().optional(),
  followed: z.boolean().optional(),
  archived: z.boolean().optional(),
  hidden: z.boolean().optional(),
  fileFormats: z.enum(constants.modelFileFormats).array().optional(),
  pending: z.boolean().optional(),
});

type QuestionFilterSchema = z.infer<typeof questionFilterSchema>;
const questionFilterSchema = z.object({
  sort: z.nativeEnum(QuestionSort).default(QuestionSort.MostLiked),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  status: z.nativeEnum(QuestionStatus).optional(),
});

type ImageFilterSchema = z.infer<typeof imageFilterSchema>;
const imageFilterSchema = z.object({
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.Week),
  periodMode: periodModeSchema.optional(),
  sort: z.nativeEnum(ImageSort).default(ImageSort.MostReactions),
  generation: z.nativeEnum(ImageGenerationProcess).array().optional(),
  excludeCrossPosts: z.boolean().optional(),
  types: z.array(z.nativeEnum(MediaType)).default([MediaType.image]),
  withMeta: z.boolean().optional(),
  fromPlatform: z.boolean().optional(),
  notPublished: z.boolean().optional(),
  hidden: z.boolean().optional(),
  followed: z.boolean().optional(),
  tools: z.number().array().optional(),
  techniques: z.number().array().optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
});

const modelImageFilterSchema = imageFilterSchema.extend({
  sort: z.nativeEnum(ImageSort).default(ImageSort.Newest), // Default sort for model images should be newest
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime), //Default period for model details should be all time
  types: z.array(z.nativeEnum(MediaType)).default([]),
});

type PostFilterSchema = z.infer<typeof postFilterSchema>;
const postFilterSchema = z.object({
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.Week),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(PostSort).default(PostSort.MostReactions),
  followed: z.boolean().optional(),
});

type ArticleFilterSchema = z.infer<typeof articleFilterSchema>;
const articleFilterSchema = z.object({
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.Month),
  periodMode: periodModeSchema,
  sort: z.nativeEnum(ArticleSort).default(ArticleSort.MostBookmarks),
  followed: z.boolean().optional(),
});

type CollectionFilterSchema = z.infer<typeof collectionFilterSchema>;
const collectionFilterSchema = z.object({
  sort: z.nativeEnum(CollectionSort).default(constants.collectionFilterDefaults.sort),
});

type BountyFilterSchema = z.infer<typeof bountyFilterSchema>;
const bountyFilterSchema = z
  .object({
    period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
    periodMode: periodModeSchema.optional(),
    sort: z.nativeEnum(BountySort).default(BountySort.EndingSoon),
    status: z.nativeEnum(BountyStatus).default(BountyStatus.Open),
  })
  .merge(
    getInfiniteBountySchema.omit({
      query: true,
      period: true,
      sort: true,
      limit: true,
      cursor: true,
      status: true,
      // TODO.bounty: remove mode from omit once we allow split bounties
      mode: true,
    })
  );

type ClubFilterSchema = z.infer<typeof clubFilterSchema>;
const clubFilterSchema = z
  .object({
    sort: z.nativeEnum(ClubSort).default(ClubSort.Newest),
  })
  .merge(
    getInfiniteClubSchema.omit({
      query: true,
      period: true,
      sort: true,
      limit: true,
      cursor: true,
      nsfw: true,
    })
  );

type VideoFilterSchema = z.infer<typeof videoFilterSchema>;
const videoFilterSchema = imageFilterSchema.omit({
  types: true,
  excludeCrossPosts: true,
});

type ThreadFilterSchema = z.infer<typeof threadFilterSchema>;
const threadFilterSchema = z.object({
  sort: z.nativeEnum(ThreadSort).default(ThreadSort.Newest),
});

export type MarkerFilterSchema = z.infer<typeof markerFilterSchema>;
const markerFilterSchema = z.object({
  marker: z.nativeEnum(MarkerType).optional(),
  tags: z.string().array().optional(),
});


type StorageState = {
  models: ModelFilterSchema;
  questions: QuestionFilterSchema;
  images: ImageFilterSchema;
  modelImages: ImageFilterSchema;
  posts: PostFilterSchema;
  articles: ArticleFilterSchema;
  collections: CollectionFilterSchema;
  bounties: BountyFilterSchema;
  clubs: ClubFilterSchema;
  videos: VideoFilterSchema;
  threads: ThreadFilterSchema;
  markers: MarkerFilterSchema;
};
export type FilterSubTypes = keyof StorageState;

const periodModeTypes = ['models', 'images', 'posts', 'articles', 'bounties'] as const;
export type PeriodModeType = (typeof periodModeTypes)[number];
export const hasPeriodMode = (type: string) => periodModeTypes.includes(type as PeriodModeType);

type FilterState = StorageState;
export type FilterKeys<K extends keyof FilterState> = keyof Pick<FilterState, K>;

type StoreState = FilterState & {
  setModelFilters: (filters: Partial<ModelFilterSchema>) => void;
  setQuestionFilters: (filters: Partial<QuestionFilterSchema>) => void;
  setImageFilters: (filters: Partial<ImageFilterSchema>) => void;
  setModelImageFilters: (filters: Partial<ImageFilterSchema>) => void;
  setPostFilters: (filters: Partial<PostFilterSchema>) => void;
  setArticleFilters: (filters: Partial<ArticleFilterSchema>) => void;
  setCollectionFilters: (filters: Partial<CollectionFilterSchema>) => void;
  setBountyFilters: (filters: Partial<BountyFilterSchema>) => void;
  setClubFilters: (filters: Partial<ClubFilterSchema>) => void;
  setVideoFilters: (filters: Partial<VideoFilterSchema>) => void;
  setThreadFilters: (filters: Partial<ThreadFilterSchema>) => void;
  setMarkerFilters: (filters: Partial<MarkerFilterSchema>) => void;
};

type LocalStorageSchema = Record<keyof StorageState, { key: string; schema: z.AnyZodObject }>;
const localStorageSchemas: LocalStorageSchema = {
  models: { key: 'model-filters', schema: modelFilterSchema },
  questions: { key: 'question-filters', schema: questionFilterSchema },
  images: { key: 'image-filters', schema: imageFilterSchema },
  modelImages: { key: 'model-image-filters', schema: modelImageFilterSchema },
  posts: { key: 'post-filters', schema: postFilterSchema },
  articles: { key: 'article-filters', schema: articleFilterSchema },
  collections: { key: 'collections-filters', schema: collectionFilterSchema },
  bounties: { key: 'bounties-filters', schema: bountyFilterSchema },
  clubs: { key: 'clubs-filters', schema: clubFilterSchema },
  videos: { key: 'videos-filters', schema: videoFilterSchema },
  threads: { key: 'thread-filters', schema: threadFilterSchema },
  markers: { key: 'marker-filters', schema: markerFilterSchema },
};

const getInitialValues = <TSchema extends z.AnyZodObject>({
  key,
  schema,
}: {
  key: string;
  schema: TSchema;
}) => {
  if (typeof window === 'undefined') return schema.parse({});
  const storageValue = localStorage.getItem(key) ?? '{}';
  const value = deserializeJSON(storageValue);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  else {
    // if the data failed to parse, get new defaults and update localstorage
    const defaults = schema.parse({});
    localStorage.setItem(key, serializeJSON(defaults));
    return defaults;
  }
};

const getInitialLocalStorageValues = () =>
  Object.entries(localStorageSchemas).reduce<Record<string, unknown>>(
    (acc, [key, value]) => ({
      ...acc,
      [key]: getInitialValues({ key: value.key, schema: value.schema }),
    }),
    {}
  ) as StorageState;

function handleLocalStorageChange<TKey extends keyof StorageState>({
  key,
  data,
  state,
}: {
  key: TKey;
  data: Record<string, unknown>;
  state: StoreState;
}) {
  const values = removeEmpty({ ...state[key], ...data });
  localStorage.setItem(localStorageSchemas[key].key, serializeJSON(values));
  return { [key]: values } as StoreState | Partial<StoreState>;
}

type FilterStore = ReturnType<typeof createFilterStore>;
const createFilterStore = () =>
  createStore<StoreState>()(
    devtools((set) => ({
      ...getInitialLocalStorageValues(),
      setModelFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'models', data, state })),
      setQuestionFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'questions', data, state })),
      setImageFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'images', data, state })),
      setModelImageFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'modelImages', data, state })),
      setPostFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'posts', data, state })),
      setArticleFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'articles', data, state })),
      setCollectionFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'collections', data, state })),
      setBountyFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'bounties', data, state })),
      setClubFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'clubs', data, state })),
      setVideoFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'videos', data, state })),
      setThreadFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'threads', data, state })),
      setMarkerFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'markers', data, state })),
    }))
  );

const FiltersContext = createContext<FilterStore | null>(null);
export function useFiltersContext<T>(selector: (state: StoreState) => T) {
  const store = useContext(FiltersContext);
  if (!store) throw new Error('Missing FiltersContext.Provider in the tree');
  return useStore(store, selector);
}

export const FiltersProvider = ({ children }: { children: React.ReactNode }) => {
  const storeRef = useRef<FilterStore>();
  if (!storeRef.current) storeRef.current = createFilterStore();

  return <FiltersContext.Provider value={storeRef.current}>{children}</FiltersContext.Provider>;
};

function serializeJSON<T>(value: T) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`Failed to serialize the value`);
  }
}

function deserializeJSON(value: string) {
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return value;
  }
}

export function useSetFilters(type: FilterSubTypes) {
  return useFiltersContext(
    useCallback(
      (state) =>
      ({
        models: state.setModelFilters,
        posts: state.setPostFilters,
        images: state.setImageFilters,
        questions: state.setQuestionFilters,
        modelImages: state.setModelImageFilters,
        articles: state.setArticleFilters,
        collections: state.setCollectionFilters,
        bounties: state.setBountyFilters,
        clubs: state.setClubFilters,
        videos: state.setVideoFilters,
        threads: state.setThreadFilters,
        markers: state.setMarkerFilters,
      }[type]),
      [type]
    )
  );
}
