import type { MantineColor } from '@mantine/core';
import { Button, Center, Loader, Progress, Select, Title } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { ReportStatus } from '~/shared/utils/prisma/enums';
import React, { useMemo, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import type { getImageRatingRequests } from '~/server/services/image.service';
import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import clsx from 'clsx';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export default function ImageRatingReview() {
  const [limit, setLimit] = useState<string>('50');
  const [cursor, setCursor] = useState<number | undefined>();
  const { data, isLoading, isFetching } = trpc.image.getImageRatingRequests.useQuery({
    limit: Number(limit),
    cursor,
  });

  const flatData = useMemo(() => data?.items ?? [], [data]);
  const fetchNextPage = () => setCursor(data?.nextCursor);
  const hasNextPage = !!data?.nextCursor;

  return (
    <div className="flex  flex-col gap-4 p-4">
      <div className="flex items-center justify-center gap-4">
        <Title>Image Rating Review</Title>
        <Select
          placeholder="Limit"
          value={limit}
          data={['10', '25', '50', '100']}
          onChange={(limit) => {
            if (limit) setLimit(limit);
          }}
        />
      </div>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !flatData?.length ? (
        <NoContent />
      ) : (
        <>
          <div
            className="grid justify-center gap-6"
            style={{ gridTemplateColumns: 'repeat(auto-fit, 300px' }}
          >
            {flatData?.map((item) => (
              <ImageRatingCard key={item.id} {...item} />
            ))}
          </div>
          {hasNextPage ? (
            <div className="flex justify-center">
              <Button size="lg" onClick={() => fetchNextPage()} loading={isFetching}>
                Next
              </Button>
            </div>
          ) : (
            <EndOfFeed />
          )}
        </>
      )}
    </div>
  );
}

function ImageRatingCard(item: AsyncReturnType<typeof getImageRatingRequests>['items'][number]) {
  // const maxRating = Math.max(...Object.values(item.votes));
  const [nsfwLevel, setNsfwLevel] = useState(item.nsfwLevel);
  const previous = usePrevious(nsfwLevel);
  const [updated, setUpdated] = useState(false);

  const { mutate } = trpc.image.updateImageNsfwLevel.useMutation({
    onError: (error) => {
      showErrorNotification({ error });
      if (previous) setNsfwLevel(previous);
    },
  });

  const handleSetLevel = (level: number) => {
    setNsfwLevel(level);
    mutate({ id: item.id, nsfwLevel: level, status: ReportStatus.Actioned });
    setUpdated(true);
  };

  return (
    <div className={clsx(`flex flex-col items-stretch card`, { [' opacity-50']: updated })}>
      <Link href={`/images/${item.id}`} target="_blank">
        <EdgeMedia src={item.url} type={item.type} width={450} className="w-full" />
      </Link>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: `min-content 1fr` }}>
          {[...browsingLevels, 32].map((level) => {
            const votes = item.votes[level];
            const sections: { value: number; label?: string; color: MantineColor }[] = [];
            if (votes > 0) {
              const percentage = votes / item.total;
              sections.unshift({
                value: percentage * 100,
                label: String(votes),
                color: 'blue',
              });
            }
            return (
              <React.Fragment key={level}>
                <Button
                  variant={nsfwLevel === level ? 'filled' : 'outline'}
                  size="compact-sm"
                  onClick={() => handleSetLevel(level)}
                  color={
                    item.nsfwLevelLocked && item.nsfwLevel === level
                      ? 'red'
                      : updated && nsfwLevel === level
                      ? 'green'
                      : 'blue'
                  }
                >
                  {getBrowsingLevelLabel(level)}
                </Button>
                <Progress.Root size={26}>
                  {sections.map((section, index) => (
                    <Progress.Section key={index} value={section.value} color={section.color}>
                      <Progress.Label>{section.label}</Progress.Label>
                    </Progress.Section>
                  ))}
                </Progress.Root>
              </React.Fragment>
            );
          })}
        </div>
        <VotableTags
          entityType="image"
          entityId={item.id}
          tags={item.tags}
          canAddModerated
          nsfwLevel={item.nsfwLevel}
        />
      </div>
    </div>
  );
}
