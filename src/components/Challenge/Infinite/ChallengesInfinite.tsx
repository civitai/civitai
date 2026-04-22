import { Center, Loader, LoadingOverlay, Stack } from '@mantine/core';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ChallengeCard } from '~/components/Cards/ChallengeCard';
import { useQueryChallenges } from '~/components/Challenge/challenge.utils';
import type { GetInfiniteChallengesInput } from '~/server/schema/challenge.schema';

type Props = {
  filters?: Partial<GetInfiniteChallengesInput>;
};

export function ChallengesInfinite({ filters }: Props) {
  const { challenges, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    useQueryChallenges(filters);

  const isLoadingInitial = isLoading && challenges.length === 0;

  return (
    <Stack pos="relative">
      <LoadingOverlay visible={isRefetching} zIndex={9} />

      {isLoadingInitial ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : challenges.length === 0 ? (
        <NoContent message="No challenges found" />
      ) : (
        <>
          <MasonryGrid
            data={challenges}
            render={ChallengeCard}
            itemId={(item) => item.id}
            empty={<NoContent message="No challenges found" />}
          />

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
