import { useMemo } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

/**
 * Hook that returns available buzz types based on current domain feature flags.
 * Mirrors the backend getAllowedAccountTypes logic for frontend consistency.
 *
 * @param baseTypes - Base array of account types to include (defaults to ['blue'])
 * @returns Array of BuzzSpendType that are allowed on the current domain
 */
export function useAvailableBuzz(baseTypes: BuzzSpendType[] = []): BuzzSpendType[] {
  const features = useFeatureFlags();

  return useMemo(() => {
    const domainTypes: BuzzSpendType[] = baseTypes.filter(
      // Remove default yellow/green if provided.
      (type) => !['yellow', 'green'].includes(type)
    );

    if (features.isGreen) {
      domainTypes.push('green');
    } else {
      domainTypes.push('yellow');
    }

    return domainTypes;
  }, [features.isGreen, baseTypes]);
}
