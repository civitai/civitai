import { FeatureFlags } from '~/server/services/feature-flags.service';
import { createContext, useContext, useState } from 'react';

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
  flags: FeatureFlags;
}) => {
  const [flags] = useState(initialFlags);
  return <FeatureFlagsCtx.Provider value={flags}>{children}</FeatureFlagsCtx.Provider>;
};
