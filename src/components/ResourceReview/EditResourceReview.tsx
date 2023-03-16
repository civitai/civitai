import { Card, Group, Rating, Stack, Text, Divider } from '@mantine/core';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';

type EditResourceReviewProps = {
  id?: number | null;
  modelName?: string | null;
  modelVersionId?: number | null;
  modelVersionName?: string | null;
  rating?: number | null;
  details?: string | null;
  createdAt?: Date | null;
};

export function EditResourceReview({
  id,
  modelName,
  modelVersionId,
  modelVersionName,
  rating: initialRating,
  details,
  createdAt,
}: EditResourceReviewProps) {
  const [rating, setRating] = useState<number | undefined>(initialRating ?? undefined);
  const { mutate, isLoading } = trpc.resourceReview.upsert.useMutation({
    onSuccess: async (response, request) => {
      return;
    },
  });

  const handleRatingChange = (value: number) => {
    console.log({ value });
  };

  return (
    <Card p={8} withBorder>
      <Stack>
        <Group align="center" position="apart" noWrap>
          <Stack spacing={0}>
            {modelName && <Text lineClamp={1}>{modelName}</Text>}
            {modelVersionName && (
              <Text lineClamp={1} size="xs" color="dimmed">
                {modelVersionName}
              </Text>
            )}
          </Stack>
          <Rating value={rating ?? undefined} onChange={handleRatingChange} />
        </Group>
        {createdAt && (
          <Text size="xs">
            Reviewed <DaysFromNow date={createdAt} />
          </Text>
        )}
      </Stack>
      {id && (
        <>
          <Card.Section>
            <Divider p={0} />
          </Card.Section>
          <Stack></Stack>
        </>
      )}
    </Card>
  );
}
