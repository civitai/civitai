import { useSession } from '~/providers/SessionProvider';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { type FeatureAccess } from '~/server/services/feature-flags.service';
import { setTrpcBatchingEnabled, trpc } from '~/utils/trpc';
import { setTrpcUnifiedBatchWindowEnabled } from '~/utils/trpc-batch-window';
import { setSiteSearchProxyEnabled } from '~/components/Search/site-search-transport';

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
 * The resolved flags, or `null` outside the provider.
 *
 * `useFeatureFlags` throws there, which is right for a component that cannot do
 * its job without flags. It is wrong for shared machinery that merely wants to
 * ASK — `useFeatureNotice` runs at every notice call site, and making it throw
 * would turn "this notice has no audience, so flags are irrelevant" into a
 * crash. Callers must decide what a `null` means for them; the notice hook
 * fails closed (see `isNoticeAudienceMatched`).
 */
export const useOptionalFeatureFlags = () => useContext(FeatureFlagsCtx);
/**
 * True once the per-user feature-flag overlay is known (or there is no logged-in
 * user). Use to defer rendering UI whose visibility depends on user flags, so it
 * doesn't flash against the anonymous SSR snapshot.
 */
export const useFeatureFlagsReady = () => useContext(FeatureFlagsReadyCtx);

/** The viewer's flags when they arrive after mount (a shell page's page data). */
export type FeatureFlagsSeed = { flags: FeatureAccess };

export const FeatureFlagsProvider = ({
  children,
  flags: initialFlags,
  userFlags,
  seed,
}: {
  children: React.ReactNode;
  flags: FeatureAccess;
  // SSR-computed per-user toggleable overlay. When present, seeds the
  // `user.getFeatureFlags` query so the client never fetches it on bootstrap.
  userFlags?: FeatureAccess;
  /** `null` while the viewer's flags are on their way (not ready), then they replace `flags` once. */
  seed?: FeatureFlagsSeed | null;
}) => {
  const session = useSession();
  const [frozenFlags] = useState(initialFlags);
  const flags = seed ? seed.flags : frozenFlags;

  const {
    data: userFeatures = {} as FeatureAccess,
    isSuccess,
    isError,
  } = trpc.user.getFeatureFlags.useQuery(undefined, {
    gcTime: Infinity,
    staleTime: Infinity,
    // A failed fetch here reads as an EMPTY overlay ({} merges over host flags),
    // and with staleTime: Infinity and this provider never remounting, nothing
    // ever refetches it — every toggleable-gated page 404s for the whole SPA
    // session on one transient failure. Retry a couple of times, and while the
    // query is errored re-enable the (globally disabled) focus refetch so a
    // later tab-in self-heals instead of staying wedged.
    retry: 2,
    refetchOnWindowFocus: (query) => query.state.status === 'error',
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
  // path: a client fetch that fails through its retries still settles to ready,
  // exactly as `isFetched` did, so consumers don't hang forever on an outage.
  const ready = seed !== null && (!session.data || isSuccess || isError);

  const featureFlags = useMemo(
    () => ({
      ...flags,
      ...userFeatures,
    }),
    [flags, userFeatures]
  );

  // Bridge `siteSearchProxy` to the module-scope search clients. Written while rendering, so the
  // searches InstantSearch starts from the first commit's effects already go the right way. Browser
  // only: on the server this module flag would be shared across concurrent requests.
  if (typeof window !== 'undefined') setSiteSearchProxyEnabled(!!featureFlags.siteSearchProxy);

  // Bridge `trpcBatching` to the module-scope tRPC link (see `shouldBatch` in
  // `~/utils/trpc`).
  //
  // With `trpcBatchingFirstCommit` on, it is written while rendering: child
  // effects run before parent effects and React Query starts a query's fetch
  // from an effect, so the effect below alone would miss the first commit's
  // queries. Browser only — on the server this module flag would be shared
  // across concurrent requests.
  if (typeof window !== 'undefined' && featureFlags.trpcBatchingFirstCommit) {
    setTrpcBatchingEnabled(!!featureFlags.trpcBatching);
    setTrpcUnifiedBatchWindowEnabled(!!featureFlags.trpcUnifiedBatchWindow);
  }
  // With `trpcBatchingFirstCommit` off, this effect is the only writer, so
  // batching applies only to queries sent after the provider has mounted. With
  // it on, this writes the value the render already wrote.
  useEffect(() => {
    setTrpcBatchingEnabled(!!featureFlags.trpcBatching);
  }, [featureFlags.trpcBatching]);
  // Same two writers for the shared batch window (see `~/utils/trpc-batch-window`).
  useEffect(() => {
    setTrpcUnifiedBatchWindowEnabled(!!featureFlags.trpcUnifiedBatchWindow);
  }, [featureFlags.trpcUnifiedBatchWindow]);

  return (
    <FeatureFlagsCtx.Provider value={featureFlags}>
      <FeatureFlagsReadyCtx.Provider value={ready}>{children}</FeatureFlagsReadyCtx.Provider>
    </FeatureFlagsCtx.Provider>
  );
};
