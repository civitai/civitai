import { createContext, useCallback, useContext, useRef } from 'react';
import * as z from 'zod';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { constants } from '~/server/common/constants';
import {
  ArticleSort,
  BountySort,
  BountyStatus,
  BuzzWithdrawalRequestSort,
  // ClubSort,
  CollectionSort,
  GenerationReactType,
  GenerationSort,
  ImageSort,
  ModelSort,
  PostSort,
  QuestionSort,
  QuestionStatus,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { getChangelogsInput } from '~/server/schema/changelog.schema';
// import { getInfiniteClubSchema } from '~/server/schema/club.schema';
import {
  Availability,
  BountyType,
  CheckpointType,
  ImageGenerationProcess,
  MediaType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
  ToolType,
} from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { baseModels } from '~/shared/constants/base-model.constants';

export type ModelFilterSchema = z.infer<typeof modelFilterSchema>;
const modelFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Month),
  periodMode: periodModeSchema,
  sort: z.enum(ModelSort).default(ModelSort.HighestRated),
  types: z.enum(ModelType).array().optional(),
  checkpointType: z.enum(CheckpointType).optional(),
  baseModels: z.enum(baseModels).array().optional(),
  status: z.enum(ModelStatus).array().optional(),
  earlyAccess: z.boolean().optional(),
  supportsGeneration: z.boolean().optional(),
  fromPlatform: z.boolean().optional(),
  followed: z.boolean().optional(),
  archived: z.boolean().optional(),
  hidden: z.boolean().optional(),
  fileFormats: z.enum(constants.modelFileFormats).array().optional(),
  pending: z.boolean().optional(),
  availability: z.enum(Availability).optional(),
  isFeatured: z.boolean().optional(),
  poiOnly: z.boolean().optional(),
  minorOnly: z.boolean().optional(),
  disablePoi: z.boolean().optional(),
  disableMinor: z.boolean().optional(),
});

type QuestionFilterSchema = z.infer<typeof questionFilterSchema>;
const questionFilterSchema = z.object({
  sort: z.enum(QuestionSort).default(QuestionSort.MostLiked),
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
  status: z.enum(QuestionStatus).optional(),
});

type ImageFilterSchema = z.infer<typeof imageFilterSchema>;
const imageFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Week),
  periodMode: periodModeSchema.optional(),
  sort: z.enum(ImageSort).default(ImageSort.MostReactions),
  generation: z.enum(ImageGenerationProcess).array().optional(),
  types: z.array(z.enum(MediaType)).default([MediaType.image]),
  withMeta: z.boolean().default(false),
  fromPlatform: z.boolean().optional(),
  hideAutoResources: z.boolean().optional(),
  hideManualResources: z.boolean().optional(),
  notPublished: z.boolean().optional(),
  scheduled: z.boolean().optional(),
  hidden: z.boolean().optional(),
  followed: z.boolean().optional(),
  tools: z.number().array().optional(),
  techniques: z.number().array().optional(),
  baseModels: z.enum(baseModels).array().optional(),
  remixesOnly: z.boolean().optional(),
  nonRemixesOnly: z.boolean().optional(),
  requiringMeta: z.boolean().optional(),
  poiOnly: z.boolean().optional(),
  minorOnly: z.boolean().optional(),
  disablePoi: z.boolean().optional(),
  disableMinor: z.boolean().optional(),
});

type ModelImageFilterSchema = z.infer<typeof modelImageFilterSchema>;
const modelImageFilterSchema = imageFilterSchema.extend({
  sort: z.enum(ImageSort).default(ImageSort.Newest), // Default sort for model images should be newest
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime), //Default period for model details should be all time
  types: z.array(z.enum(MediaType)).default([]),
});

type PostFilterSchema = z.infer<typeof postFilterSchema>;
const postFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Week),
  periodMode: periodModeSchema,
  sort: z.enum(PostSort).default(PostSort.MostReactions),
  followed: z.boolean().optional(),
});

type ArticleFilterSchema = z.infer<typeof articleFilterSchema>;
const articleFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Month),
  periodMode: periodModeSchema,
  sort: z.enum(ArticleSort).default(ArticleSort.MostBookmarks),
  followed: z.boolean().optional(),
});

type CollectionFilterSchema = z.infer<typeof collectionFilterSchema>;
const collectionFilterSchema = z.object({
  sort: z.enum(CollectionSort).default(constants.collectionFilterDefaults.sort),
});

type BountyFilterSchema = z.infer<typeof bountyFilterSchema>;
const bountyFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
  periodMode: periodModeSchema.optional(),
  sort: z.enum(BountySort).default(BountySort.EndingSoon),
  status: z.enum(BountyStatus).default(BountyStatus.Open),
  types: z.enum(BountyType).array().optional(),
  nsfw: z.boolean().optional(),
  engagement: z.enum(constants.bounties.engagementTypes).optional(),
  userId: z.number().optional(),
  baseModels: z.enum(baseModels).array().optional(),
  excludedUserIds: z.number().array().optional(),
});

// type ClubFilterSchema = z.infer<typeof clubFilterSchema>;
// const clubFilterSchema = z.object({
//   sort: z.enum(ClubSort).default(ClubSort.Newest),
//   ...getInfiniteClubSchema.omit({
//     sort: true,
//     limit: true,
//     cursor: true,
//     nsfw: true,
//   }).shape,
// });

type VideoFilterSchema = z.infer<typeof videoFilterSchema>;
const videoFilterSchema = imageFilterSchema;

type ThreadFilterSchema = z.infer<typeof threadFilterSchema>;
const threadFilterSchema = z.object({
  sort: z.enum(ThreadSort).default(ThreadSort.Newest),
});

export type GenerationFilterSchema = z.infer<typeof generationFilterSchema>;
const generationFilterSchema = z.object({
  sort: z.enum(GenerationSort).default(GenerationSort.Newest),
  marker: z.enum(GenerationReactType).optional(),
  tags: z.string().array().optional(),
});

type ToolFilterSchema = z.infer<typeof toolFilterSchema>;
const toolFilterSchema = z.object({
  sort: z.enum(ToolSort).default(ToolSort.Newest),
  type: z.enum(ToolType).optional(),
});
type BuzzWithdrawalRequestFilterSchema = z.infer<typeof buzzWithdrawalRequestFilterSchema>;
const buzzWithdrawalRequestFilterSchema = z.object({
  sort: z.enum(BuzzWithdrawalRequestSort).default(BuzzWithdrawalRequestSort.Newest),
});

export type ChangelogFilterSchema = z.infer<typeof changelogFilterSchema>;
const changelogFilterSchema = getChangelogsInput.omit({
  cursor: true,
  limit: true,
  search: true,
});

export type AuctionFilterSchema = z.infer<typeof auctionFilterSchema>;
const auctionFilterSchema = z.object({
  baseModels: z.enum(baseModels).array().optional(),
});

type StorageState = {
  models: ModelFilterSchema;
  questions: QuestionFilterSchema;
  images: ImageFilterSchema;
  modelImages: ModelImageFilterSchema;
  posts: PostFilterSchema;
  articles: ArticleFilterSchema;
  collections: CollectionFilterSchema;
  bounties: BountyFilterSchema;
  // clubs: ClubFilterSchema;
  videos: VideoFilterSchema;
  threads: ThreadFilterSchema;
  generation: GenerationFilterSchema;
  tools: ToolFilterSchema;
  buzzWithdrawalRequests: BuzzWithdrawalRequestFilterSchema;
  changelogs: ChangelogFilterSchema;
  auctions: AuctionFilterSchema;
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
  setModelImageFilters: (filters: Partial<ModelImageFilterSchema>) => void;
  setPostFilters: (filters: Partial<PostFilterSchema>) => void;
  setArticleFilters: (filters: Partial<ArticleFilterSchema>) => void;
  setCollectionFilters: (filters: Partial<CollectionFilterSchema>) => void;
  setBountyFilters: (filters: Partial<BountyFilterSchema>) => void;
  // setClubFilters: (filters: Partial<ClubFilterSchema>) => void;
  setVideoFilters: (filters: Partial<VideoFilterSchema>) => void;
  setThreadFilters: (filters: Partial<ThreadFilterSchema>) => void;
  setGenerationFilters: (filters: Partial<GenerationFilterSchema>) => void;
  setToolFilters: (filters: Partial<ToolFilterSchema>) => void;
  setBuzzWithdrawalRequestFilters: (filters: Partial<BuzzWithdrawalRequestFilterSchema>) => void;
  setChangelogFilters: (filters: Partial<ChangelogFilterSchema>) => void;
  setAuctionFilters: (filters: Partial<AuctionFilterSchema>) => void;
};

type LocalStorageSchema = Record<keyof StorageState, { key: string; schema: z.ZodObject }>;
const localStorageSchemas: LocalStorageSchema = {
  models: { key: 'model-filters', schema: modelFilterSchema },
  questions: { key: 'question-filters', schema: questionFilterSchema },
  images: { key: 'image-filters', schema: imageFilterSchema },
  modelImages: { key: 'model-image-filters', schema: modelImageFilterSchema },
  posts: { key: 'post-filters', schema: postFilterSchema },
  articles: { key: 'article-filters', schema: articleFilterSchema },
  collections: { key: 'collections-filters', schema: collectionFilterSchema },
  bounties: { key: 'bounties-filters', schema: bountyFilterSchema },
  // clubs: { key: 'clubs-filters', schema: clubFilterSchema },
  videos: { key: 'videos-filters', schema: videoFilterSchema },
  threads: { key: 'thread-filters', schema: threadFilterSchema },
  generation: { key: 'generation-filters', schema: generationFilterSchema },
  tools: { key: 'tool-filters', schema: toolFilterSchema },
  buzzWithdrawalRequests: {
    key: 'buzz-withdrawal-request-filters',
    schema: buzzWithdrawalRequestFilterSchema,
  },
  changelogs: { key: 'changelog-filters', schema: changelogFilterSchema },
  auctions: { key: 'auction-filters', schema: auctionFilterSchema },
};

const getInitialValues = <TSchema extends z.ZodObject>({
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
      // setClubFilters: (data) =>
      //   set((state) => handleLocalStorageChange({ key: 'clubs', data, state })),
      setVideoFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'videos', data, state })),
      setThreadFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'threads', data, state })),
      setGenerationFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'generation', data, state })),
      setToolFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'tools', data, state })),
      setBuzzWithdrawalRequestFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'buzzWithdrawalRequests', data, state })),
      setChangelogFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'changelogs', data, state })),
      setAuctionFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'auctions', data, state })),
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
          // clubs: state.setClubFilters,
          videos: state.setVideoFilters,
          threads: state.setThreadFilters,
          generation: state.setGenerationFilters,
          tools: state.setToolFilters,
          buzzWithdrawalRequests: state.setBuzzWithdrawalRequestFilters,
          changelogs: state.setChangelogFilters,
          auctions: state.setAuctionFilters,
        }[type]),
      [type]
    )
  );
}
