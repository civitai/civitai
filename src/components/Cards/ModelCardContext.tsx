import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { MODEL_SALE_IDS_PER_QUERY } from '~/shared/zod/model-sale.schema';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

type SalesByModelId = Record<
  number,
  { endsAt: Date; discountType: 'Fixed' | 'Percent'; discountAmount: number }
>;

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
  /** Set by a container that supplies the map, so cards do not each fetch their own. */
  hasSaleProvider?: boolean;
  /** modelId -> its running sale. Absent means no sale. */
  salesByModelId?: SalesByModelId;
};

const ModelCardContext = createContext<Context | null>(null);

export const useModelCardContext = () => {
  const context = useContext(ModelCardContext);
  return context ?? {};
};

/**
 * One lookup per page of cards, not one per card, and deliberately not part of the model query: the feed
 * query is a hot path and a sale is time-varying, so indexing it would mean re-indexing at every window
 * edge. Same shape as how cosmetics and version images are already fetched after the fact.
 */
/**
 * The sale for ONE model, for a card rendered outside any provider — home blocks, collections, related
 * models, search results.
 *
 * ⚠️ This is one request PER CARD. tRPC only batches for an authenticated browser (see shouldBatch in
 * utils/trpc.ts), so an anonymous grid issues one XHR each, and even when batched the URL cap fits about
 * 24 ops. A container that can supply the map should pass `salesByModelId` and skip this entirely —
 * that is why the skip flag is "a provider owns this", not "the provider's data has arrived".
 */
export const useModelSaleBadge = (modelId: number, skip: boolean) => {
  const { data } = trpc.model.getActiveSales.useQuery(
    { ids: [modelId] },
    { enabled: !skip, staleTime: 60_000 }
  );
  return data?.[modelId];
};

/**
 * The sales for a whole surface of cards.
 *
 * 🔴 CHUNKED, because the procedure caps `ids` at `MODEL_SALE_IDS_PER_QUERY` and an infinite feed
 * does not stop growing. Asking for the accumulated list in one call worked until the fifth page
 * of ~100 cards, and from there EVERY call 400d — so the badge silently vanished from the whole
 * grid for anyone who scrolled, on a money surface, invisibly to anything watching 5xx.
 *
 * Chunking is the fix rather than a bigger cap: the resolver's work is per-id (one Redis GET each,
 * plus a five-table `IN (…)` for the misses) on a PUBLIC procedure, so the cap is the only bound
 * on it. See `~/shared/zod/model-sale.schema`.
 *
 * The shared chunker, not a third copy of it — its own tests pin the property this depends on and
 * does not spell out in code: chunking in ARRIVAL order keeps an earlier chunk's key stable as the
 * feed appends, where sorting would reshuffle every boundary and refetch the whole surface on each
 * page. Growing by a page therefore costs ONE new request, not one per chunk.
 */
export const useModelSaleBadges = (modelIds: number[]) => {
  const chunks = useMemo(
    () => chunkIds(modelIds, MODEL_SALE_IDS_PER_QUERY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelIds.join(',')]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.model.getActiveSales({ ids: chunk }, { staleTime: 60_000, placeholderData: (prev) => prev })
    )
  );

  return useMemo(() => {
    // `undefined` while nothing has arrived, exactly as the single query returned — a consumer
    // reads "no sale yet", not "no sale". A partly-loaded surface merges what it has, so badges
    // appear per chunk instead of the whole grid waiting on the slowest one.
    const loaded = queries.map((query) => query.data).filter((data) => !!data);
    if (!loaded.length) return undefined;
    return Object.assign({}, ...loaded) as SalesByModelId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((query) => query.dataUpdatedAt).join(',')]);
};

export const ModelCardContextProvider = ({
  children,
  useModelVersionRedirect,
  activeBaseModels,
  salesByModelId,
  hasSaleProvider,
}: Context & { children: ReactNode }) => {
  const value = useMemo(
    () => ({ useModelVersionRedirect, activeBaseModels, salesByModelId, hasSaleProvider }),
    [useModelVersionRedirect, activeBaseModels, salesByModelId, hasSaleProvider]
  );
  return <ModelCardContext.Provider value={value}>{children}</ModelCardContext.Provider>;
};
