import { Card, Stack, Group, Text, Rating, Progress } from '@mantine/core';
import { RatingTotalsModel } from '~/server/services/resourceReview.service';
import { trpc } from '~/utils/trpc';

const ratings = ['5', '4', '3', '2', '1'] as (keyof RatingTotalsModel)[];

export function ResourceReviewTotals({ modelId }: { modelId: number }) {
  const { data, isLoading } = trpc.resourceReview.getRatingTotals.useQuery({ modelId });

  const total = data ? Object.values(data).reduce<number>((acc, value) => acc + value, 0) : 0;
  const average =
    data && total !== undefined
      ? Object.entries(data).reduce<number>((acc, [key, value]) => {
          return acc + Number(key) * value;
        }, 0) / total
      : 0;

  return (
    <Card p="xs">
      <Stack>
        <Stack spacing="xs">
          <Text>Reviews</Text>
          <Group>
            <Rating value={average} />
            <Text>{average} out of 5</Text>
          </Group>
        </Stack>
        <Text size="sm" color="dimmed">
          {total} global ratings
        </Text>
        <Stack spacing="sm">
          {ratings.map((rating) => {
            const progress = data ? data[rating] / total : 0;
            return (
              <Group key={rating} noWrap position="apart">
                <Text component="span">{rating} star</Text>
                <Progress value={progress} size="lg" />
                <Text component="span">{progress}%</Text>
              </Group>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}
