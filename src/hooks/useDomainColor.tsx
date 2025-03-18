import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ColorDomain } from '~/server/common/constants';

export function useDomainColor() {
  const { isGreen, isBlue, isRed } = useFeatureFlags();
  const color: ColorDomain = isGreen ? 'green' : isBlue ? 'blue' : isRed ? 'red' : 'blue';
  return color;
}
