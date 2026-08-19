import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
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
 * models, search results. tRPC batches concurrent queries into a single HTTP request, so a grid of cards
 * still costs one round trip, and the per-model result is cached by react-query for the whole page.
 *
 * A container that already has the map (the main feed) passes it down instead, and this stays disabled.
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
}: Context & { children: ReactNode }) => {
  const value = useMemo(
    () => ({ useModelVersionRedirect, activeBaseModels, salesByModelId }),
    [useModelVersionRedirect, activeBaseModels, salesByModelId]
  );
  return <ModelCardContext.Provider value={value}>{children}</ModelCardContext.Provider>;
};
