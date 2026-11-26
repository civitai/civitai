import { Text } from '@mantine/core';
import type { TextProps } from '@mantine/core';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { serviceHappyShare } from '~/shared/constants/creator-service.constants';
import { pluralize } from '~/shared/utils/pluralize';

/**
 * "92% happy · 12 reviews" over one offering or a seller's listed offerings, once enough buyers
 * count. Only in the creatorServicesNext rollout; outside a flags provider it renders nothing.
 */
export function ServiceHappyLine({
  counts,
  ...props
}: { counts: { happyCount?: number; reviewCount?: number }[] } & TextProps) {
  const features = useOptionalFeatureFlags();
  if (!features?.creatorServicesNext) return null;
  const share = serviceHappyShare(
    counts.map((c) => ({ happyCount: c.happyCount ?? 0, reviewCount: c.reviewCount ?? 0 }))
  );
  if (!share) return null;
  return (
    <Text size="sm" c="dimmed" {...props}>
      {share.percent}% happy · {pluralize(share.reviews, 'review')}
    </Text>
  );
}
