import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo, useState } from 'react';
import { type FeatureAccess } from '~/server/services/feature-flags.service';
import { trpc } from '~/utils/trpc';

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
}: {
  children: React.ReactNode;
  flags: FeatureAccess;
}) => {
  const session = useSession();
  const [flags] = useState(initialFlags);

  const { data: userFeatures = {} as FeatureAccess, isFetched } =
    trpc.user.getFeatureFlags.useQuery(undefined, {
      gcTime: Infinity,
      staleTime: Infinity,
      retry: 0,
      enabled: !!session.data,
    });

  // Logged-out (query disabled) → ready immediately on the complete SSR flags.
  // Logged-in → ready once the user overlay has settled (success or error).
  const ready = !session.data || isFetched;

  const featureFlags = useMemo(
    () => ({
      ...flags,
      ...userFeatures,
    }),
    [flags, userFeatures]
  );

  return (
    <FeatureFlagsCtx.Provider value={featureFlags}>
      <FeatureFlagsReadyCtx.Provider value={ready}>{children}</FeatureFlagsReadyCtx.Provider>
    </FeatureFlagsCtx.Provider>
  );
};
