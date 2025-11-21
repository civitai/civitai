import type { MantineColor } from '@mantine/core';
import { Button, Center, Group, Loader, Select, Title } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import clsx from 'clsx';
import React, { useMemo, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { NsfwLevel } from '~/server/common/enums';
import type { getDownleveledImages } from '~/server/services/image.service';
import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { ReportStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const limitsData = [10, 25, 50, 100].map((num) => ({ value: String(num), label: `${num} items` }));

const levelOptions = [
  { value: 'all', label: 'All Levels' },
  ...browsingLevels.map((level) => ({
    value: String(level),
    label: getBrowsingLevelLabel(level),
  })),
  { value: String(NsfwLevel.Blocked), label: getBrowsingLevelLabel(NsfwLevel.Blocked) },
];

export default function DownleveledReview() {
  const [limit, setLimit] = useState<string>('50');
  const [cursor, setCursor] = useState<string | undefined>();
  const [originalLevel, setOriginalLevel] = useState<string>('all');

  const { data, isLoading, isFetching } = trpc.image.getDownleveledImages.useQuery({
    limit: Number(limit),
    cursor,
    originalLevel: originalLevel === 'all' ? undefined : Number(originalLevel),
  });

  const flatData = useMemo(() => data?.items ?? [], [data]);
  const fetchNextPage = () => setCursor(data?.nextCursor);
  const hasNextPage = !!data?.nextCursor;

  const handleOriginalLevelChange = (value: string | null) => {
    if (value) {
      setOriginalLevel(value);
      setCursor(undefined); // Reset cursor when filter changes
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <Title>Downleveled Images Review</Title>
        <Group gap={8}>
          <Select
            placeholder="Original Level"
            value={originalLevel}
            data={levelOptions}
            onChange={handleOriginalLevelChange}
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
            style={{ gridTemplateColumns: 'repeat(auto-fit, 300px)' }}
          >
            {flatData?.map((item) => (
              <DownleveledImageCard key={item.id} {...item} />
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

function DownleveledImageCard(item: AsyncReturnType<typeof getDownleveledImages>['items'][number]) {
  const [nsfwLevel, setNsfwLevel] = useState(item.nsfwLevel);
  const previous = usePrevious(nsfwLevel);
  const [updated, setUpdated] = useState(false);

  const { mutate } = trpc.image.updateImageNsfwLevel.useMutation({
    onError: (error) => {
      showErrorNotification({ error });
      if (previous) setNsfwLevel(previous);
    },
  });

  const handleSetLevel = (level: NsfwLevel) => {
    setNsfwLevel(level);
    mutate({
      id: item.id,
      nsfwLevel: level,
    });
    setUpdated(true);
  };

  return (
    <div className={clsx('flex flex-col items-stretch card', { ' opacity-50': updated })}>
      <Link href={`/images/${item.id}`} target="_blank">
        <EdgeMedia src={item.url} type={item.type} width={450} className="w-full" />
      </Link>
      <div className="flex flex-col gap-4 p-4">
        <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          {[...browsingLevels, NsfwLevel.Blocked].map((level) => {
            const isOriginalLevel = level === item.originalLevel;
            const isCurrentLevel = nsfwLevel === level;
            const wasUpdated = updated && isCurrentLevel;

            return (
              <Button
                key={level}
                variant={isCurrentLevel ? 'filled' : isOriginalLevel ? 'outline' : 'outline'}
                size="xs"
                onClick={() => handleSetLevel(level)}
                color={wasUpdated ? 'green' : isOriginalLevel ? 'red' : 'blue'}
              >
                {getBrowsingLevelLabel(level)}
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
