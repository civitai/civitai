import { Anchor, Card, Center, Group, Loader, Stack } from '@mantine/core';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { Empty } from '~/components/Empty/Empty';

import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { SFW } from '~/components/Media/SFW';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GetAllBountiesSchema } from '~/server/schema/bounty.schema';
import { BountyGetAllItem } from '~/types/router';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function InfiniteBounties({ filters }: Props) {
  const { ref, inView } = useInView();

  const {
    data: bountiesData,
    isLoading,
    fetchNextPage,
    hasNextPage,
  } = trpc.bounty.getAll.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      keepPreviousData: true,
    }
  );

  const bounties = useMemo(
    () => bountiesData?.pages.flatMap(({ items }) => items) ?? [],
    [bountiesData?.pages]
  );

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  if (isLoading)
    return (
      <Center>
        <Loader size="xl" />
      </Center>
    );

  return (
    <Stack>
      {bounties.length > 0 ? (
        <MasonryGrid items={bounties} render={(props) => <BountyCard {...props} />} />
      ) : (
        <Empty message="Try adjusting your search or filters to find what you're looking for" />
      )}
      {hasNextPage ? (
        <Group position="center" ref={ref}>
          <Loader />
        </Group>
      ) : null}
    </Stack>
  );
}

type Props = {
  filters?: GetAllBountiesSchema;
};

function BountyCard({ data }: BountyCardProps) {
  const currentUser = useCurrentUser();

  const { id, name, nsfw } = data;

  return (
    <Link href={`/bounties/${id}/${slugit(name)}`} passHref>
      <Anchor variant="text">
        <Card withBorder shadow="sm" p={0}>
          <SFW type="model" id={id} nsfw={nsfw}>
            <SFW.ToggleNsfw />
          </SFW>
        </Card>
      </Anchor>
    </Link>
  );
}

type BountyCardProps = {
  data: BountyGetAllItem;
};
