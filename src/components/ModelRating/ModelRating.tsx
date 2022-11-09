import { Group, Rating, RatingProps, Text } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelWithDetails } from '~/server/validators/models/getById';

export function ModelRating({ rank, ...props }: Props) {
  return (
    <Group spacing={4}>
      <Rating value={rank?.ratingAllTime ?? 0} fractions={2} readOnly {...props} />
      <Text size="sm">({rank?.ratingCountAllTime ?? 0})</Text>
    </Group>
  );
}

type Props = RatingProps & {
  rank: ModelWithDetails['rank'];
};
