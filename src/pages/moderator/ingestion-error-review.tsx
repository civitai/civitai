import { Badge, Button, Center, Group, Loader, Select, Title } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import clsx from 'clsx';
import React, { useState } from 'react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import { NsfwLevel } from '~/server/common/enums';
import type { getIngestionErrorImages } from '~/server/services/image.service';
import { browsingLevels, getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const limitsData = [10, 25, 50, 100].map((num) => ({ value: String(num), label: `${num} items` }));

export default function IngestionErrorReview() {
  const [limit, setLimit] = useState<string>('50');
  const [cursor, setCursor] = useState<number | undefined>();
  const { data, isLoading, isFetching } = trpc.image.getIngestionErrorImages.useQuery({
    limit: Number(limit),
    cursor,
  });

  const flatData = data?.items ?? [];
  const fetchNextPage = () => setCursor(data?.nextCursor);
  const hasNextPage = !!data?.nextCursor;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-4">
        <Title>Ingestion Error Review</Title>
        <Group gap={8}>
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
            {flatData.map((item) => (
              <IngestionErrorCard key={item.id} {...item} />
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

type IngestionErrorItem = AsyncReturnType<typeof getIngestionErrorImages>['items'][number];

function IngestionErrorCard(item: IngestionErrorItem) {
  const [nsfwLevel, setNsfwLevel] = useState(item.nsfwLevel);
  const previous = usePrevious(nsfwLevel);
  const [updated, setUpdated] = useState(false);

  const { mutate } = trpc.image.resolveIngestionError.useMutation({
    onError: (error) => {
      showErrorNotification({ error });
      if (previous) setNsfwLevel(previous);
      setUpdated(false);
    },
  });

  const handleSetLevel = (level: NsfwLevel) => {
    setNsfwLevel(level);
    mutate({ id: item.id, nsfwLevel: level });
    setUpdated(true);
  };

  return (
    <div className={clsx('flex flex-col items-stretch card', { 'opacity-50': updated })}>
      {/* NSFW Level Selection Badges */}
      <div className="flex flex-wrap gap-1 p-2">
        {[...browsingLevels, NsfwLevel.Blocked].map((level) => (
          <Badge
            key={level}
            variant={nsfwLevel === level ? 'filled' : 'outline'}
            color={updated && nsfwLevel === level ? 'green' : 'blue'}
            className="cursor-pointer"
            onClick={() => handleSetLevel(level)}
          >
            {getBrowsingLevelLabel(level)}
          </Badge>
        ))}
      </div>

      {/* Image */}
      <Link href={`/images/${item.id}`} target="_blank">
        <EdgeMedia2 src={item.url} type={item.type as MediaType} width={450} className="w-full" />
      </Link>
    </div>
  );
}
