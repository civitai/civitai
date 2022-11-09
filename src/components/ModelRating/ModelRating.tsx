import { Group, Rating, RatingProps, Text } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelWithDetails } from '~/server/validators/models/getById';

export function ModelRating({ metrics, ...props }: Props) {
  const allTimeMetric = metrics?.find((metric) => metric.timeframe === MetricTimeframe.AllTime);

  return (
    <Group spacing={4}>
      <Rating value={allTimeMetric?.rating ?? 0} fractions={2} readOnly {...props} />
      <Text size="sm">({allTimeMetric?.ratingCount ?? 0})</Text>
    </Group>
  );
}

type Props = RatingProps & {
  metrics: ModelWithDetails['metrics'];
};
