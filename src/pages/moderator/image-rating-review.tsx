import {
  Badge,
  Button,
  Center,
  Loader,
  MantineColor,
  Progress,
  Select,
  Title,
} from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { ReportStatus } from '@prisma/client';
import React, { useMemo, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { getImageRatingRequests } from '~/server/services/image.service';
import { browsingLevelLabels, browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function ImageRatingReview() {
  const [limit, setLimit] = useState<string>('50');
  const [cursor, setCursor] = useState<string | undefined>();
  const { data, isLoading, isFetching } = trpc.image.getImageRatingRequests.useQuery({
    limit: Number(limit),
    cursor,
  });

  const flatData = useMemo(() => data?.items ?? [], [data]);
  const fetchNextPage = () => setCursor(data?.nextCursor);
  const hasNextPage = !!data?.nextCursor;

  return (
    <div className="p-4  flex flex-col gap-4">
      <div className="flex justify-center gap-4 items-center">
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
            className="grid gap-6 justify-center"
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
  const maxRating = Math.max(...Object.values(item.votes));
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
    <div className={`flex flex-col items-stretch card ${updated ? '!border-green-600' : ''}`}>
      <NextLink href={`/images/${item.id}`} target="_blank">
        <EdgeMedia src={item.url} type={item.type} width={450} className="w-full" />
      </NextLink>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: `min-content 1fr` }}>
          {browsingLevels.map((level) => {
            const votes = item.votes[level];
            const sections: { value: number; label?: string; color: MantineColor }[] = [];
            if (votes > 0) {
              const count = item.ownerVote > 0 ? votes - 1 : votes;
              const percentage = count / maxRating;
              sections.unshift({
                value: percentage * 100,
                label: String(votes),
                color: 'blue',
              });
            }
            if (item.ownerVote > 0 && item.ownerVote === level) {
              sections.unshift({
                value: (1 / maxRating) * 100,
                color: 'yellow',
              });
            }
            return (
              <React.Fragment key={level}>
                <Button
                  variant={nsfwLevel === level ? 'filled' : 'outline'}
                  compact
                  onClick={() => handleSetLevel(level)}
                  color={
                    item.nsfwLevelLocked && item.nsfwLevel === level
                      ? 'red'
                      : updated && nsfwLevel === level
                      ? 'green'
                      : 'blue'
                  }
                >
                  {browsingLevelLabels[level]}
                </Button>
                <Progress size={26} sections={sections} />
              </React.Fragment>
            );
          })}
        </div>
        <VotableTags entityType="image" entityId={item.id} tags={item.tags} canAddModerated />
      </div>
    </div>
  );
}
