import type { MantineColor } from '@mantine/core';
import { Button, Center, Checkbox, Group, Loader, Progress, Select, Title } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import clsx from 'clsx';
import React, { useMemo, useState } from 'react';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { NsfwLevel } from '~/server/common/enums';
import type { getImageRatingRequests } from '~/server/services/image.service';
import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { ReportStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const limitsData = [10, 25, 50, 100].map((num) => ({ value: String(num), label: `${num} items` }));

export default function ImageRatingReview() {
  const [limit, setLimit] = useState<string>('50');
  const [cursor, setCursor] = useState<number | undefined>();
  const [requireReason, setRequireReason] = useState(false);
  const { data, isLoading, isFetching } = trpc.image.getImageRatingRequests.useQuery({
    limit: Number(limit),
    cursor,
  });

  const flatData = useMemo(() => data?.items ?? [], [data]);
  const fetchNextPage = () => setCursor(data?.nextCursor);
  const hasNextPage = !!data?.nextCursor;

  return (
    <div className="flex  flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <Title>Image Rating Review</Title>
        <Group gap={8}>
          <Checkbox
            label="Require reason"
            checked={requireReason}
            onChange={(event) => setRequireReason(event.currentTarget.checked)}
          />
          <Select
            placeholder="Limit"
            value={limit}
            data={limitsData}
            onChange={(limit) => {
              if (limit) setLimit(limit);
            }}
          />
        </Group>
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
              <ImageRatingCard key={item.id} {...item} requireReason={requireReason} />
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

function ImageRatingCard(
  item: AsyncReturnType<typeof getImageRatingRequests>['items'][number] & { requireReason: boolean }
) {
  const { requireReason, ...imageItem } = item;
  // const maxRating = Math.max(...Object.values(item.votes));
  const [nsfwLevel, setNsfwLevel] = useState(imageItem.nsfwLevel);
  const previous = usePrevious(nsfwLevel);
  const [updated, setUpdated] = useState(false);

  const { mutate } = trpc.image.updateImageNsfwLevel.useMutation({
    onError: (error) => {
      showErrorNotification({ error });
      if (previous) setNsfwLevel(previous);
    },
  });

  const handleSetLevel = (level: NsfwLevel) => {
    if (requireReason) {
      openSetBrowsingLevelModal({
        imageId: imageItem.id,
        nsfwLevel: level,
        hideLevelSelect: true,
        onSubmit: ({ reason }) => {
          setNsfwLevel(level);
          mutate({
            id: imageItem.id,
            nsfwLevel: level,
            status: ReportStatus.Actioned,
            reason: reason ?? undefined,
          });
          setUpdated(true);
        },
      });
    } else {
      setNsfwLevel(level);
      mutate({
        id: imageItem.id,
        nsfwLevel: level,
        status: ReportStatus.Actioned,
      });
      setUpdated(true);
    }
  };

  return (
    <div className={clsx(`flex flex-col items-stretch card`, { [' opacity-50']: updated })}>
      <Link href={`/images/${imageItem.id}`} target="_blank">
        <EdgeMedia src={imageItem.url} type={imageItem.type} width={450} className="w-full" />
      </Link>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: `min-content 1fr` }}>
          {[...browsingLevels, NsfwLevel.Blocked].map((level) => {
            const votes = imageItem.votes[level];
            const sections: { value: number; label?: string; color: MantineColor }[] = [];
            if (votes > 0) {
              const percentage = votes / imageItem.total;
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
                    imageItem.nsfwLevelLocked && imageItem.nsfwLevel === level
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
          entityId={imageItem.id}
          tags={imageItem.tags}
          canAddModerated
          nsfwLevel={imageItem.nsfwLevel}
        />
      </div>
    </div>
  );
}
