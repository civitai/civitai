import {
  Badge,
  Button,
  Center,
  Chip,
  Container,
  Group,
  Loader,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { useMemo } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { getImageRatingRequests } from '~/server/services/image.service';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

export default function ImageRatingReview() {
  const { data, isLoading, hasNextPage, fetchNextPage, isRefetching } =
    trpc.image.getImageRatingRequests.useInfiniteQuery(
      { limit: 5 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !flatData?.length ? (
        <NoContent />
      ) : (
        <>
          <div
            className="grid gap-6 m-4 justify-center"
            style={{ gridTemplateColumns: 'repeat(auto-fit, 300px' }}
          >
            {flatData?.map((item) => (
              <ImageRatingCard key={item.id} {...item} />
            ))}
          </div>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching && hasNextPage}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" sx={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && <EndOfFeed />}
        </>
      )}
    </>
  );
}

function ImageRatingCard(item: AsyncReturnType<typeof getImageRatingRequests>['items'][number]) {
  const maxRating = Math.max(...Object.values(item.votes));

  return (
    <div className="flex flex-col items-center card">
      <EdgeMedia src={item.url} type={item.type} width={450} className="w-full" />
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: `min-content 1fr` }}>
          {browsingLevels.map((level) => {
            const count = item.votes[level];
            const percentage = count / maxRating;
            return (
              <>
                <Button
                  key={level}
                  variant={item.nsfwLevel === level ? 'filled' : 'outline'}
                  compact
                >
                  {browsingLevelLabels[level]}
                </Button>
                <Progress value={percentage * 100} label={`${count}`} size={26} />
              </>
            );
          })}
        </div>
        {!!item.tags.length && (
          <div className="flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <Badge key={tag.id} size="xs">
                {tag.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
