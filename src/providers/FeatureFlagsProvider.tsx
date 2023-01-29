import { FeatureFlags, getFeatureFlags } from '~/server/services/feature-flags.service';
import { createContext, useContext, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const FeatureFlagsCtx = createContext<FeatureFlags>({} as FeatureFlags);

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
  flags: FeatureFlags | undefined;
}) => {
  const user = useCurrentUser() ?? undefined;
  const [flags] = useState(initialFlags ?? getFeatureFlags({ user }));
  return <FeatureFlagsCtx.Provider value={flags}>{children}</FeatureFlagsCtx.Provider>;
};
