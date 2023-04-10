import { Stack, Group, Text, Rating, Progress, createStyles, Skeleton } from '@mantine/core';
import { createContext, useContext, Fragment } from 'react';
import { ResourceReviewRatingTotals } from '~/types/router';
import { trpc } from '~/utils/trpc';

type ContextState = {
  count: number;
  rating: number;
  loading?: boolean;
  totals?: ResourceReviewRatingTotals;
  modelVersionId?: number;
};

type Props = {
  modelId: number;
  modelVersionId?: number;
  children: React.ReactNode;
};

const SummaryContext = createContext<ContextState | null>(null);
const useSummaryContext = () => {
  const context = useContext(SummaryContext);
  if (!context) throw new Error('SummaryContext not in tree');
  return context;
};

export function ResourceReviewSummary({ modelId, modelVersionId, children }: Props) {
  const { data, isLoading, isRefetching } = trpc.resourceReview.getRatingTotals.useQuery({
    modelId,
    modelVersionId,
  });

  const count = data ? Object.values(data).reduce<number>((acc, value) => acc + value, 0) : 0;

  const rating =
    data && !!count
      ? Object.entries(data).reduce<number>((acc, [key, value]) => {
          return acc + Number(key) * value;
        }, 0) / count
      : 0;

  // const roundedRating = Math.round(rating * 100) / 100;

  return (
    <SummaryContext.Provider
      value={{
        count,
        rating: rating,
        loading: isLoading || isRefetching,
        totals: data,
        modelVersionId,
      }}
    >
      {children}
    </SummaryContext.Provider>
  );
}

ResourceReviewSummary.Header = function Header({
  rating: initialRating,
  count: initialCount,
}: {
  rating?: number;
  count?: number;
}) {
  const { rating, count, modelVersionId, loading } = useSummaryContext();
  const roundedRating = Math.round((initialRating ?? rating) * 100) / 100;
  const showSkeleton = loading && (!initialRating || !initialCount);

  return (
    <Stack spacing={0}>
      {showSkeleton ? (
        <>
          <Skeleton height={12.8} my={6} />
          <Skeleton height={12.8} my={6} />
        </>
      ) : (
        <>
          <Group>
            <Text>Reviews</Text>
            <Text size="sm" color="dimmed">
              {initialCount ?? count} {!!modelVersionId ? 'version' : ''} ratings
            </Text>
          </Group>
          <Group>
            <Rating value={roundedRating} readOnly />
            <Text>{roundedRating} out of 5</Text>
          </Group>
        </>
      )}
    </Stack>
  );
};

const ratings = ['5', '4', '3', '2', '1'] as (keyof ResourceReviewRatingTotals)[];
ResourceReviewSummary.Totals = function Totals() {
  const { classes } = useStyles();
  const { totals, count, loading } = useSummaryContext();

  return loading ? (
    <Stack spacing={4}>
      {ratings.map((r) => (
        <Skeleton height={12} my={6} key={r} />
      ))}
    </Stack>
  ) : (
    <div className={classes.grid}>
      {ratings.map((rating) => {
        const progress = (totals && count ? totals[rating] / count : 0) * 100;
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
  );
};

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr max-content',
    alignItems: 'center',
    columnGap: theme.spacing.md,
    rowGap: 4,
  },
}));
