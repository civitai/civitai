import { useSession } from '~/providers/SessionProvider';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { type FeatureAccess } from '~/server/services/feature-flags.service';
import { setTrpcBatchingEnabled, trpc } from '~/utils/trpc';

const FeatureFlagsCtx = createContext<FeatureAccess | null>(null);
// Whether the per-user `getFeatureFlags` overlay has resolved. SSR seeds
// host-level flags synchronously, but user-specific flags arrive via the
// client query — consumers that would flash if they rendered against the
// anon SSR flags (chat icon, migration alerts) gate on this instead of
// forcing their own `getSettings` refetch.
const FeatureFlagsReadyCtx = createContext<boolean>(true);

export type UseFeatureFlagsReturn = ReturnType<typeof useFeatureFlags>;
export const useFeatureFlags = () => {
  const context = useContext(FeatureFlagsCtx);
  if (!context) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');
  return context;
};
/**
 * True once the per-user feature-flag overlay is known (or there is no logged-in
 * user). Use to defer rendering UI whose visibility depends on user flags, so it
 * doesn't flash against the anonymous SSR snapshot.
 */
export const useFeatureFlagsReady = () => useContext(FeatureFlagsReadyCtx);
export const FeatureFlagsProvider = ({
  children,
  flags: initialFlags,
  userFlags,
}: {
  children: React.ReactNode;
  flags: FeatureAccess;
  // SSR-computed per-user toggleable overlay. When present, seeds the
  // `user.getFeatureFlags` query so the client never fetches it on bootstrap.
  userFlags?: FeatureAccess;
}) => {
  const session = useSession();
  const [flags] = useState(initialFlags);

  const {
    data: userFeatures = {} as FeatureAccess,
    isSuccess,
    isError,
  } = trpc.user.getFeatureFlags.useQuery(undefined, {
    gcTime: Infinity,
    staleTime: Infinity,
    retry: 0,
    enabled: !!session.data,
    initialData: userFlags,
  });

  // Logged-out (query disabled) → ready immediately on the complete SSR flags.
  // Logged-in → ready once the per-user overlay is KNOWN, i.e. the query has
  // SETTLED (success or error) — matching #2464's original `isFetched` gate.
  //
  // Why `isSuccess || isError` instead of `isFetched`: with an SSR seed
  // (`initialData`) React Query marks the query `isSuccess: true` from frame 0
  // and never performs a network fetch (staleTime: Infinity), so `isFetched`
  // stays FALSE forever — which would wedge readiness false for every seeded
  // logged-in user and permanently hide the chat icon + 3 migration alerts.
  // `isSuccess` flips true immediately on the seed (no flash: user flags are
  // present from frame 0). The `|| isError` arm preserves the no-seed error
  // path (retry: 0): a failed client fetch still settles to ready, exactly as
  // `isFetched` did, so consumers don't hang forever on a transient failure.
  const ready = !session.data || isSuccess || isError;

  const featureFlags = useMemo(
    () => ({
      ...flags,
      ...userFeatures,
    }),
    [flags, userFeatures]
  );

  // Bridge the resolved `trpcBatching` flag to the module-scope tRPC terminating
  // link (which can't read a hook). Runs client-side only; until this fires the
  // link stays unbatched (dark default), so anon + early-hydration queries never
  // batch. See `shouldBatch` in `~/utils/trpc`.
  useEffect(() => {
    setTrpcBatchingEnabled(!!featureFlags.trpcBatching);
  }, [featureFlags.trpcBatching]);

  return (
    <FeatureFlagsCtx.Provider value={featureFlags}>
      <FeatureFlagsReadyCtx.Provider value={ready}>{children}</FeatureFlagsReadyCtx.Provider>
    </FeatureFlagsCtx.Provider>
  );
};
