import { listingSortSchema } from '~/server/schema/blocks/app-listing-read.schema';
import { createContext, useCallback, useContext, useRef } from 'react';
import { HAT_SORTS } from '~/shared/constants/hat-turf-feed.constants';
import * as z from 'zod';
import { createStore, useStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { constants } from '~/server/common/constants';
import {
  ArticleSort,
  BountySort,
  BountyStatus,
  BuzzWithdrawalRequestSort,
  CollectionSort,
  CrucibleSort,
  GenerationReactType,
  GenerationSort,
  ImageSort,
  ModelSort,
  PostSort,
  ThreadSort,
  ToolSort,
} from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { getChangelogsInput } from '~/server/schema/changelog.schema';
import {
  Availability,
  BountyType,
  CheckpointType,
  CrucibleStatus,
  ImageGenerationProcess,
  MediaType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
  ToolType,
} from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { publishedDateSchema } from '~/shared/utils/published-range';
import { CRUCIBLE_CONTENT_TYPES } from '~/shared/constants/crucible.constants';

export type ModelFilterSchema = z.infer<typeof modelFilterSchema>;
const modelFilterSchema = z.object({
  // AllTime: a recency FILTER can empty a page, and on a tag page it usually does. Hot ranks
  // recency instead, and a sort cannot drop rows.
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
  periodMode: periodModeSchema,
  publishedFrom: publishedDateSchema.optional(),
  publishedTo: publishedDateSchema.optional(),
  sort: z.enum(ModelSort).default(ModelSort.Hot),
  types: z.enum(ModelType).array().optional(),
  checkpointType: z.enum(CheckpointType).optional(),
  baseModels: z.enum(baseModels).array().optional(),
  status: z.enum(ModelStatus).array().optional(),
  earlyAccess: z.boolean().optional(),
  paidAccess: z.boolean().optional(),
  hidePaid: z.boolean().optional(),
  onSale: z.boolean().optional(),
  supportsGeneration: z.boolean().optional(),
  fromPlatform: z.boolean().optional(),
  followed: z.boolean().optional(),
  newCreators: z.boolean().optional(),
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
export const modelSortPeriodDefaults = modelFilterSchema
  .pick({ sort: true, period: true })
  .parse({});

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
  newCreators: z.boolean().optional(),
  tools: z.number().array().optional(),
  techniques: z.number().array().optional(),
  baseModels: z.enum(baseModels).array().optional(),
  remixesOnly: z.boolean().optional(),
  nonRemixesOnly: z.boolean().optional(),
  requiringMeta: z.boolean().optional(),
  hideChallenges: z.boolean().optional(),
  poiOnly: z.boolean().optional(),
  minorOnly: z.boolean().optional(),
  disablePoi: z.boolean().optional(),
  disableMinor: z.boolean().optional(),
  // Green-domain only: opt-in to PG-13 content on image/video feeds.
  // Default off — feeds show PG only until user toggles this on.
  includePG13: z.boolean().optional(),
  // Hat Turf players only; the server ignores these from anyone else.
  hatSort: z.enum(HAT_SORTS).optional(),
  hatTeams: z.string().array().optional(),
  hatTurfMine: z.boolean().optional(),
  hideTurfHats: z.boolean().optional(),
  hideWornHats: z.boolean().optional(),
});

type ModelImageFilterSchema = z.infer<typeof modelImageFilterSchema>;
const modelImageFilterSchema = imageFilterSchema.extend({
  // Most Reactions, not Newest: a model gallery opening on Newest fronts images
  // that may not be rated yet, which is the sort SFW viewers are not offered.
  sort: z.enum(ImageSort).default(ImageSort.MostReactions),
  period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime), //Default period for model details should be all time
  types: z.array(z.enum(MediaType)).default([]),
});

type PostFilterSchema = z.infer<typeof postFilterSchema>;
const postFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Week),
  periodMode: periodModeSchema,
  sort: z.enum(PostSort).default(PostSort.MostReactions),
  followed: z.boolean().optional(),
  scheduled: z.boolean().optional(),
});

type ArticleFilterSchema = z.infer<typeof articleFilterSchema>;
const articleFilterSchema = z.object({
  period: z.enum(MetricTimeframe).default(MetricTimeframe.Month),
  periodMode: periodModeSchema,
  sort: z.enum(ArticleSort).default(ArticleSort.MostBookmarks),
  followed: z.boolean().optional(),
});
const redArticleFilterSchema = articleFilterSchema.extend({
  sort: z.enum(ArticleSort).default(ArticleSort.Newest),
});

type CollectionFilterSchema = z.infer<typeof collectionFilterSchema>;
const collectionFilterSchema = z.object({
  sort: z.enum(CollectionSort).default(constants.collectionFilterDefaults.sort),
});

// The URL query a collection view was last left on, per content type. Validated again when it is
// used, so a value an enum has since dropped is discarded there.
export type CollectionFeedFilterSchema = z.infer<typeof collectionFeedFilterSchema>;
const collectionFeedFilterSchema = z.object({
  query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

export type AppsStoreFilterSchema = z.infer<typeof appsStoreFilterSchema>;
const appsStoreFilterSchema = z.object({
  sort: listingSortSchema.optional().catch(undefined),
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

type CrucibleFilterSchema = z.infer<typeof crucibleFilterSchema>;
const crucibleFilterSchema = z.object({
  sort: z.enum(CrucibleSort).default(CrucibleSort.PrizePool),
  status: z.enum(CrucibleStatus).array().optional(),
  contentType: z.enum(CRUCIBLE_CONTENT_TYPES).optional(),
});

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
  baseModel: z.string().optional(),
  processType: z.string().optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  excludeFailed: z.boolean().optional(),
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
  images: ImageFilterSchema;
  modelImages: ModelImageFilterSchema;
  posts: PostFilterSchema;
  articles: ArticleFilterSchema;
  collections: CollectionFilterSchema;
  collectionModels: CollectionFeedFilterSchema;
  collectionImages: CollectionFeedFilterSchema;
  collectionPosts: CollectionFeedFilterSchema;
  collectionArticles: CollectionFeedFilterSchema;
  appsStore: AppsStoreFilterSchema;
  bounties: BountyFilterSchema;
  crucibles: CrucibleFilterSchema;
  videos: VideoFilterSchema;
  threads: ThreadFilterSchema;
  generation: GenerationFilterSchema;
  tools: ToolFilterSchema;
  buzzWithdrawalRequests: BuzzWithdrawalRequestFilterSchema;
  changelogs: ChangelogFilterSchema;
  auctions: AuctionFilterSchema;
};
export type CollectionFeedKey =
  | 'collectionModels'
  | 'collectionImages'
  | 'collectionPosts'
  | 'collectionArticles';
// Without the keys that remember a URL query or a lone sort rather than filters a feed can run on.
export type FilterSubTypes = Exclude<keyof StorageState, CollectionFeedKey | 'appsStore'>;

const periodModeTypes = ['models', 'images', 'posts', 'articles', 'bounties'] as const;
export type PeriodModeType = (typeof periodModeTypes)[number];
export const hasPeriodMode = (type: string) => periodModeTypes.includes(type as PeriodModeType);

type FilterState = StorageState;
export type FilterKeys<K extends keyof FilterState> = keyof Pick<FilterState, K>;

type StoreState = FilterState & {
  setModelFilters: (filters: Partial<ModelFilterSchema>) => void;
  setImageFilters: (filters: Partial<ImageFilterSchema>) => void;
  setModelImageFilters: (filters: Partial<ModelImageFilterSchema>) => void;
  setPostFilters: (filters: Partial<PostFilterSchema>) => void;
  setArticleFilters: (filters: Partial<ArticleFilterSchema>) => void;
  setCollectionFilters: (filters: Partial<CollectionFilterSchema>) => void;
  setCollectionModelFilters: (filters: Partial<CollectionFeedFilterSchema>) => void;
  setCollectionImageFilters: (filters: Partial<CollectionFeedFilterSchema>) => void;
  setCollectionPostFilters: (filters: Partial<CollectionFeedFilterSchema>) => void;
  setCollectionArticleFilters: (filters: Partial<CollectionFeedFilterSchema>) => void;
  setAppsStoreFilters: (filters: Partial<AppsStoreFilterSchema>) => void;
  setBountyFilters: (filters: Partial<BountyFilterSchema>) => void;
  setCrucibleFilters: (filters: Partial<CrucibleFilterSchema>) => void;
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
  images: { key: 'image-filters', schema: imageFilterSchema },
  modelImages: { key: 'model-image-filters', schema: modelImageFilterSchema },
  posts: { key: 'post-filters', schema: postFilterSchema },
  articles: { key: 'article-filters', schema: articleFilterSchema },
  collections: { key: 'collections-filters', schema: collectionFilterSchema },
  collectionModels: { key: 'collection-model-filters', schema: collectionFeedFilterSchema },
  collectionImages: { key: 'collection-image-filters', schema: collectionFeedFilterSchema },
  collectionPosts: { key: 'collection-post-filters', schema: collectionFeedFilterSchema },
  collectionArticles: { key: 'collection-article-filters', schema: collectionFeedFilterSchema },
  appsStore: { key: 'apps-store-filters', schema: appsStoreFilterSchema },
  bounties: { key: 'bounties-filters', schema: bountyFilterSchema },
  crucibles: { key: 'crucibles-filters', schema: crucibleFilterSchema },
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

/**
 * One-time rewrite of the old default pair (`Highest Rated` + `Month`). The store persists
 * its whole merged state on every change, defaults included, so anyone who ever touched a
 * model filter has those saved as though chosen, and would otherwise keep them forever.
 * Only the exact pair is replaced, so a real choice of either field survives.
 */
export const MODEL_FILTER_MIGRATION_KEY = 'model-filters-migration';
export const MODEL_FILTER_MIGRATION_VERSION = '1-hot-default';

function rewriteOncePerVersion({
  key,
  value,
  filterKey,
  migrationKey,
  version,
  isOldDefault,
  rewrite,
}: {
  key: string;
  value: Record<string, unknown>;
  filterKey: string;
  migrationKey: string;
  version: string;
  isOldDefault: (value: Record<string, unknown>) => boolean;
  rewrite: (value: Record<string, unknown>) => Record<string, unknown>;
}) {
  if (key !== filterKey) return value;
  if (localStorage.getItem(migrationKey) === version) return value;

  const isOld = isOldDefault(value);
  const migrated = isOld ? rewrite(value) : value;

  localStorage.setItem(migrationKey, version);
  if (isOld) localStorage.setItem(key, serializeJSON(migrated));
  return migrated;
}

export function migrateModelFilters(key: string, value: Record<string, unknown>) {
  return rewriteOncePerVersion({
    key,
    value,
    filterKey: localStorageSchemas.models.key,
    migrationKey: MODEL_FILTER_MIGRATION_KEY,
    version: MODEL_FILTER_MIGRATION_VERSION,
    isOldDefault: (v) => v?.sort === ModelSort.HighestRated && v?.period === MetricTimeframe.Month,
    rewrite: (v) => ({ ...v, sort: ModelSort.Hot, period: MetricTimeframe.AllTime }),
  });
}

/** civitai.red defaults articles to Newest; same stored-default issue as migrateModelFilters. */
export const RED_ARTICLE_FILTER_MIGRATION_KEY = 'article-filters-migration';
export const RED_ARTICLE_FILTER_MIGRATION_VERSION = '1-red-newest';

export function migrateRedArticleFilters(key: string, value: Record<string, unknown>) {
  return rewriteOncePerVersion({
    key,
    value,
    filterKey: localStorageSchemas.articles.key,
    migrationKey: RED_ARTICLE_FILTER_MIGRATION_KEY,
    version: RED_ARTICLE_FILTER_MIGRATION_VERSION,
    isOldDefault: (v) =>
      v?.sort === ArticleSort.MostBookmarks && v?.period === MetricTimeframe.Month,
    rewrite: (v) => ({ ...v, sort: ArticleSort.Newest }),
  });
}

const getInitialValues = <TSchema extends z.ZodObject>({
  key,
  schema,
  isRed,
}: {
  key: string;
  schema: TSchema;
  isRed: boolean;
}) => {
  if (typeof window === 'undefined') return schema.parse({});
  const storageValue = localStorage.getItem(key) ?? '{}';
  let value = migrateModelFilters(key, deserializeJSON(storageValue));
  if (isRed) value = migrateRedArticleFilters(key, value);
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  else {
    // if the data failed to parse, get new defaults and update localstorage
    const defaults = schema.parse({});
    localStorage.setItem(key, serializeJSON(defaults));
    return defaults;
  }
};

export const getInitialLocalStorageValues = ({ isRed }: { isRed: boolean }) =>
  Object.entries(localStorageSchemas).reduce<Record<string, unknown>>(
    (acc, [key, value]) => ({
      ...acc,
      [key]: getInitialValues({
        key: value.key,
        schema: isRed && key === 'articles' ? redArticleFilterSchema : value.schema,
        isRed,
      }),
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
const createFilterStore = ({ isRed }: { isRed: boolean }) =>
  createStore<StoreState>()(
    devtools((set) => ({
      ...getInitialLocalStorageValues({ isRed }),
      setModelFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'models', data, state })),
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
      setCollectionModelFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'collectionModels', data, state })),
      setCollectionImageFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'collectionImages', data, state })),
      setCollectionPostFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'collectionPosts', data, state })),
      setCollectionArticleFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'collectionArticles', data, state })),
      setAppsStoreFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'appsStore', data, state })),
      setBountyFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'bounties', data, state })),
      setCrucibleFilters: (data) =>
        set((state) => handleLocalStorageChange({ key: 'crucibles', data, state })),
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

export const FiltersProvider = ({
  children,
  isRed = false,
}: {
  children: React.ReactNode;
  isRed?: boolean;
}) => {
  const storeRef = useRef<FilterStore>();
  if (!storeRef.current) storeRef.current = createFilterStore({ isRed });

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

export function useSetFilters(type: FilterSubTypes | CollectionFeedKey) {
  return useFiltersContext(
    useCallback(
      (state) =>
        ({
          models: state.setModelFilters,
          posts: state.setPostFilters,
          images: state.setImageFilters,
          modelImages: state.setModelImageFilters,
          articles: state.setArticleFilters,
          collections: state.setCollectionFilters,
          collectionModels: state.setCollectionModelFilters,
          collectionImages: state.setCollectionImageFilters,
          collectionPosts: state.setCollectionPostFilters,
          collectionArticles: state.setCollectionArticleFilters,
          bounties: state.setBountyFilters,
          crucibles: state.setCrucibleFilters,
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
