import { Group, Rating, RatingProps, Text } from '@mantine/core';
import { abbreviateNumber } from '~/utils/number-helpers';

export function ModelRating({ rank, ...props }: Props) {
  return (
    <Group gap={4}>
      <Rating value={rank?.ratingAllTime ?? 0} fractions={2} readOnly {...props} />
      <Text size={'sm'} fz={props.size}>
        ({abbreviateNumber(rank?.ratingCountAllTime ?? 0)})
      </Text>
    </Group>
  );
}

type Props = RatingProps & {
  rank: {
    ratingAllTime: number;
    ratingCountAllTime: number;
  } | null;
};
