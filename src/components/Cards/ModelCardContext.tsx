import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
  /** Set by a container that supplies the map, so cards do not each fetch their own. */
  hasSaleProvider?: boolean;
  /** modelId -> its running sale. Absent means no sale. */
  salesByModelId?: Record<
    number,
    { endsAt: Date; discountType: 'Fixed' | 'Percent'; discountAmount: number }
  >;
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

export const useModelSaleBadges = (modelIds: number[]) => {
  const ids = useMemo(() => [...new Set(modelIds)].sort((a, b) => a - b), [modelIds]);
  const { data } = trpc.model.getActiveSales.useQuery(
    { ids },
    { enabled: ids.length > 0, staleTime: 60_000, placeholderData: (prev) => prev }
  );
  return data;
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
