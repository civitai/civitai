import { Badge, Card, createStyles, Group, Rating, Skeleton, Stack, Text } from '@mantine/core';
import { IconDownload, IconMessageCircle2, IconHeart, IconStar } from '@tabler/icons';
import Link from 'next/link';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { abbreviateNumber } from '~/utils/number-helpers';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles(() => ({
  statBadge: {
    background: 'rgba(212,212,212,0.2)',
    color: 'white',
  },
}));

export function GalleryResources({ imageId, modelId, reviewId }: Props) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();

  const { data: connections, isLoading } = trpc.image.getConnectionData.useQuery({
    id: imageId,
    modelId,
    reviewId,
  });

  const { data: { Favorite: favoriteModels = [] } = { Favorite: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const isFavorite = favoriteModels.find((id) => modelId === id);

  return (
    <Link href={`/models/${connections?.model?.id}`} passHref>
      <Card component="a" p={8} sx={{ backgroundColor: theme.colors.dark[7] }} withBorder>
        {isLoading ? (
          <Stack spacing="xs">
            <Skeleton height={16} radius="md" />
            <Skeleton height={16} radius="md" />
          </Stack>
        ) : connections && connections.model ? (
          <Stack spacing="xs">
            <Group spacing={4} position="apart" noWrap>
              <Text size="sm" weight={500} lineClamp={1}>
                {connections.model.name}
              </Text>
              <Badge radius="sm" size="sm">
                {splitUppercase(connections.model.type)}
              </Badge>
            </Group>
            <Group spacing={0} position="apart">
              <IconBadge
                className={classes.statBadge}
                sx={{ userSelect: 'none' }}
                icon={
                  <Rating
                    size="xs"
                    value={connections.model.rank?.ratingAllTime ?? 0}
                    readOnly
                    fractions={4}
                    emptySymbol={
                      <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
                    }
                  />
                }
              >
                <Text
                  size="xs"
                  color={
                    connections.model.rank && connections.model.rank.ratingCountAllTime > 0
                      ? undefined
                      : 'dimmed'
                  }
                >
                  {abbreviateNumber(connections.model.rank?.ratingCountAllTime ?? 0)}
                </Text>
              </IconBadge>
              <Group spacing={4}>
                <IconBadge
                  className={classes.statBadge}
                  icon={
                    <IconHeart
                      size={14}
                      style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
                      color={isFavorite ? theme.colors.red[6] : undefined}
                    />
                  }
                  color={isFavorite ? 'red' : 'gray'}
                >
                  <Text size="xs">
                    {abbreviateNumber(connections.model.rank?.favoriteCountAllTime ?? 0)}
                  </Text>
                </IconBadge>
                <IconBadge className={classes.statBadge} icon={<IconMessageCircle2 size={14} />}>
                  <Text size="xs">
                    {abbreviateNumber(connections.model.rank?.commentCountAllTime ?? 0)}
                  </Text>
                </IconBadge>
                <IconBadge className={classes.statBadge} icon={<IconDownload size={14} />}>
                  <Text size={12}>
                    {abbreviateNumber(connections.model.rank?.downloadCountAllTime ?? 0)}
                  </Text>
                </IconBadge>
              </Group>
            </Group>
          </Stack>
        ) : null}
      </Card>
    </Link>
  );
}

type Props = { imageId: number; modelId: number | null; reviewId: number | null };
