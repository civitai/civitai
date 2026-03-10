import { Center, Loader, LoadingOverlay, SimpleGrid, Stack } from '@mantine/core';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { CompletedChallengeCard } from '~/components/Cards/CompletedChallengeCard';
import { useQueryCompletedChallengesWithWinners } from '~/components/Challenge/challenge.utils';
import type { GetCompletedChallengesWithWinnersInput } from '~/server/schema/challenge.schema';

type Props = {
  filters?: Partial<GetCompletedChallengesWithWinnersInput>;
};

export function CompletedChallengesInfinite({ filters }: Props) {
  const { challenges, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    useQueryCompletedChallengesWithWinners(filters);

  const isLoadingInitial = isLoading && challenges.length === 0;

  return (
    <Stack pos="relative" gap="md">
      <LoadingOverlay visible={isRefetching} zIndex={9} />

      {isLoadingInitial ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : challenges.length === 0 ? (
        <NoContent message="No completed challenges with winners yet" />
      ) : (
        <>
          <SimpleGrid cols={1} spacing="md">
            {challenges.map((challenge) => (
              <CompletedChallengeCard key={challenge.id} data={challenge} />
            ))}
          </SimpleGrid>

          {hasNextPage && (
            <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage && hasNextPage}>
              <Center p="xl">
                <Loader size="lg" />
              </Center>
            </InViewLoader>
          )}

          {!hasNextPage && challenges.length > 0 && <EndOfFeed />}
        </>
      )}
    </Stack>
  );
}
