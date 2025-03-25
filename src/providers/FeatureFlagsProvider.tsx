import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo, useState, useEffect } from 'react';
import { getFeatureFlags, type FeatureAccess } from '~/server/services/feature-flags.service';
import { trpc } from '~/utils/trpc';

const FeatureFlagsCtx = createContext<FeatureAccess | null>(null);

export type UseFeatureFlagsReturn = ReturnType<typeof useFeatureFlags>;
export const useFeatureFlags = () => {
  const context = useContext(FeatureFlagsCtx);
  if (!context) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');
  return context;
};
export const FeatureFlagsProvider = ({
  children,
  flags: initialFlags,
}: {
  children: React.ReactNode;
  flags?: FeatureAccess;
}) => {
  const session = useSession();
  // Ensures FE and BE feature flags are in sync for staging.
  const host = (location.host ?? '').replace('stage.', '');
  const [flags, setFlags] = useState(
    initialFlags ?? getFeatureFlags({ user: session.data?.user, host })
  );

  useEffect(() => {
    setFlags(getFeatureFlags({ user: session.data?.user, host }));
  }, [session.data?.expires]);

  const { data: userFeatures = {} as FeatureAccess } = trpc.user.getFeatureFlags.useQuery(
    undefined,
    { cacheTime: Infinity, staleTime: Infinity, retry: 0, enabled: !!session.data }
  );

  const featureFlags = useMemo(
    () => ({
      ...flags,
      ...userFeatures,
    }),
    [flags, userFeatures]
  );

  return <FeatureFlagsCtx.Provider value={featureFlags}>{children}</FeatureFlagsCtx.Provider>;
};
