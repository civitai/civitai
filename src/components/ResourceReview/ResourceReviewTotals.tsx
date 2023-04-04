import { Card, Stack, Group, Text, Rating, Progress, createStyles, Accordion } from '@mantine/core';
import { RatingTotalsModel } from '~/server/services/resourceReview.service';
import { trpc } from '~/utils/trpc';
import { Fragment } from 'react';
const ratings = ['5', '4', '3', '2', '1'] as (keyof RatingTotalsModel)[];

export function ResourceReviewTotals({
  modelVersionId,
  rating,
  count,
}: {
  modelVersionId: number;
  rating?: number;
  count?: number;
}) {
  const { classes, cx } = useStyles();
  const { data, isLoading } = trpc.resourceReview.getRatingTotals.useQuery({ modelVersionId });

  const total = data
    ? Object.values(data).reduce<number>((acc, value) => acc + value, 0)
    : undefined;
  const average =
    rating ??
    (data && !!total
      ? Object.entries(data).reduce<number>((acc, [key, value]) => {
          return acc + Number(key) * value;
        }, 0) / total
      : 0);
  const roundedAverage = Math.round(average * 100) / 100;

  return (
    <Accordion.Item value="resource-reviews">
      <Accordion.Control>
        <Stack spacing={0}>
          <Group>
            <Text>Reviews</Text>
            <Text size="sm" color="dimmed">
              {total ?? count} version ratings
            </Text>
          </Group>
          <Group>
            <Rating value={roundedAverage} readOnly />
            <Text>{roundedAverage} out of 5</Text>
          </Group>
        </Stack>
      </Accordion.Control>
      <Accordion.Panel px="sm" pb="sm">
        <div className={classes.grid}>
          {ratings.map((rating) => {
            const progress = (data && total ? data[rating] / total : 0) * 100;
            const rounded = Math.ceil(progress);
            return (
              <Fragment key={rating}>
                <Text>{rating} star</Text>
                <Progress value={progress} color="yellow" size="lg" />
                <Text align="right">{rounded}%</Text>
              </Fragment>
            );
          })}
        </div>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr max-content',
    alignItems: 'center',
    columnGap: theme.spacing.md,
    rowGap: 4,
  },
}));
