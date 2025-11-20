import { createContext, useContext } from 'react';
import { type FeatureAccess } from '~/server/services/feature-flags.service';

export const FeatureFlagsCtx = createContext<FeatureAccess | null>(null);

export type UseFeatureFlagsReturn = ReturnType<typeof useFeatureFlags>;
export const useFeatureFlags = () => {
  const context = useContext(FeatureFlagsCtx);
  if (!context) throw new Error('useFeatureFlags can only be used inside FeatureFlagsCtx');
  return context;
};
