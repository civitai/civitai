import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ColorDomain } from '~/server/common/constants';

export function useDomainColor() {
  const { isGreen, isBlue, isRed } = useFeatureFlags();
  // Fallback to green for being the safest of the bunch.
  const color: ColorDomain = isGreen ? 'green' : isBlue ? 'blue' : isRed ? 'red' : 'green';
  return color;
}
