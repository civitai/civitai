import { Group, Rating, RatingProps, Text } from '@mantine/core';
import { GetModelReturnType } from '~/server/controllers/model.controller';

export function ModelRating({ rank, ...props }: Props) {
  return (
    <Group spacing={4}>
      <Rating value={rank?.ratingAllTime ?? 0} fractions={2} readOnly {...props} />
      <Text size="sm">({rank?.ratingCountAllTime.toLocaleString() ?? 0})</Text>
    </Group>
  );
}

type Props = RatingProps & {
  rank: GetModelReturnType['rank'];
};
