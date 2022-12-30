import {
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  createStyles,
  Group,
  Loader,
  LoadingOverlay,
  Stack,
  Text,
} from '@mantine/core';
import { IconHeart, IconMessageCircle2, IconTrophy, IconViewfinder } from '@tabler/icons';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { useBountyFilters } from '~/components/Bounties/BountiesProvider';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Empty } from '~/components/Empty/Empty';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { SFW } from '~/components/Media/SFW';
import { constants } from '~/server/common/constants';
import { BountyGetAllItem } from '~/types/router';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit, splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function InfiniteBounties() {
  const { ref, inView } = useInView();
  const filters = useBountyFilters();

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

function BountyCard({ data }: BountyCardProps) {
  const { classes, theme } = useStyles();

  const { id, name, nsfw, image, type, rank } = data;

  const [loading, setLoading] = useState(false);

  return (
    <Link href={`/bounties/${id}/${slugit(name)}`} passHref>
      <Anchor variant="text">
        <Card
          withBorder
          shadow="sm"
          p={0}
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
          }}
        >
          <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
          <SFW type="model" id={id} nsfw={nsfw}>
            <SFW.ToggleNsfw />
            <SFW.Placeholder>
              <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                <MediaHash {...image} />
              </AspectRatio>
            </SFW.Placeholder>
            <SFW.Content>
              <EdgeImage
                src={image.url}
                alt={image.name ?? undefined}
                width={450}
                placeholder="empty"
                style={{ width: '100%', zIndex: 2, position: 'relative' }}
              />
            </SFW.Content>
          </SFW>
          <Box p="xs" className={classes.content}>
            <Stack spacing={6}>
              <Group position="left" spacing={4}>
                <Text size={14} weight={500} lineClamp={1} style={{ flex: 1 }}>
                  {name}
                </Text>
                <Badge radius="sm" size="xs">
                  {splitUppercase(type)}
                </Badge>
              </Group>
              <Group position="apart">
                <IconBadge
                  icon={<IconTrophy size={14} />}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                >
                  <Text size="xs">{abbreviateNumber(rank.bountyValue)}</Text>
                </IconBadge>
                <Group spacing={4}>
                  <IconBadge
                    icon={<IconViewfinder size={14} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  >
                    <Text size="xs">{abbreviateNumber(rank.hunterCount)}</Text>
                  </IconBadge>
                  <IconBadge
                    icon={<IconHeart size={14} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  >
                    <Text size="xs">{abbreviateNumber(rank.favoriteCount)}</Text>
                  </IconBadge>
                  <IconBadge
                    icon={<IconMessageCircle2 size={14} />}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  >
                    <Text size="xs">{abbreviateNumber(rank.commentCount)}</Text>
                  </IconBadge>
                </Group>
              </Group>
            </Stack>
          </Box>
        </Card>
      </Anchor>
    </Link>
  );
}

type BountyCardProps = {
  data: BountyGetAllItem;
};

const useStyles = createStyles((theme) => {
  const base = theme.colors[getRandom(constants.mantineColors)];
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';

  return {
    card: {
      height: '300px',
      cursor: 'pointer',
      background: theme.fn.gradient({ from: base[9], to: background, deg: 180 }),
    },

    content: {
      background,
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: 0,
      zIndex: 10,
    },
  };
});
