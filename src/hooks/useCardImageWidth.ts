import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { DEFAULT_EDGE_IMAGE_WIDTH, SMALLER_EDGE_IMAGE_WIDTH } from '~/server/common/constants';

export function useCardImageWidth() {
  const { smallerImages } = useFeatureFlags();
  return smallerImages ? SMALLER_EDGE_IMAGE_WIDTH : DEFAULT_EDGE_IMAGE_WIDTH;
}
