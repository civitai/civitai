import {
  Badge,
  Center,
  Chip,
  Container,
  Group,
  Loader,
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
            className="grid gap-6 m-4"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))' }}
          >
            {flatData?.map((item) => (
              <ImageRatingCard key={item.id} {...item} />
            ))}
          </div>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching && hasNextPage}
              // Forces a re-render whenever the amount of images fetched changes. Forces load-more if available.
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

const browsingLevelOptions = browsingLevels.map((level) => ({
  label: browsingLevelLabels[level],
  value: level,
}));
function ImageRatingCard(item: AsyncReturnType<typeof getImageRatingRequests>['items'][number]) {
  return (
    <div className="flex gap-2 items-center justify-center w-full">
      <div className="flex-1">
        <EdgeMedia src={item.url} type={item.type} width={450} />
        <div className="flex">
          {browsingLevels.map((level) => {
            return (
              <Chip key={level} checked={item.nsfwLevel === level}>
                {browsingLevelLabels[level]}
              </Chip>
            );
          })}
        </div>
      </div>
      {!!item.tags.length && (
        <div className="flex flex-col gap-1">
          {item.tags.map((tag) => (
            <Badge key={tag.id} size="xs">
              {tag.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
