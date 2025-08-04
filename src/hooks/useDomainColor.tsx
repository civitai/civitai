import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ColorDomain } from '~/shared/constants/domain.constants';

export function useDomainColor() {
  const { isGreen, isBlue, isRed } = useFeatureFlags();
  // Fallback to green for being the safest of the bunch.
  const color: ColorDomain = isGreen ? 'green' : isBlue ? 'blue' : isRed ? 'red' : 'blue';
  return color;
}
