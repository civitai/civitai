import type { ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { trpc } from '~/utils/trpc';

type Context = {
  useModelVersionRedirect?: boolean;
  activeBaseModels?: string[];
  /** modelId -> when its running sale ends. Absent means no sale. */
  salesByModelId?: Record<number, { endsAt: Date }>;
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
