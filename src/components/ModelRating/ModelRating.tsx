import { Group, Rating, RatingProps, Text } from '@mantine/core';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelWithDetails } from '~/server/validators/models/getById';

export function ModelRating({ rank, ...props }: Props) {
  const mobile = useIsMobile();

  return (
    <Group spacing={4}>
      <Rating
        value={rank?.ratingAllTime}
        fractions={mobile ? 5 : 2}
        count={mobile ? 1 : undefined}
        readOnly
        {...props}
      />
      <Text size="sm">({rank?.ratingAllTime.toLocaleString() ?? 0})</Text>
    </Group>
  );
}

type Props = RatingProps & { rank: ModelWithDetails['rank'] };
