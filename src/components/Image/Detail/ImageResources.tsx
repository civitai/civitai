import {
  Badge,
  Card,
  createStyles,
  Group,
  Rating,
  Skeleton,
  Stack,
  Text,
  Alert,
} from '@mantine/core';
import { IconDownload, IconMessageCircle2, IconHeart, IconStar } from '@tabler/icons';
import Link from 'next/link';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageResourceModel } from '~/server/controllers/image.controller';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { cloneElement } from 'react';

const useStyles = createStyles(() => ({
  statBadge: {
    background: 'rgba(212,212,212,0.2)',
    color: 'white',
  },
}));

export function ImageResources({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const { data, isLoading } = trpc.image.getResources.useQuery({ id: imageId });

  const { data: { Favorite: favoriteModels = [] } = { Favorite: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  return (
    <Stack>
      {isLoading ? (
        <Stack spacing="xs">
          <Skeleton height={16} radius="md" />
          <Skeleton height={16} radius="md" />
        </Stack>
      ) : !!data?.length ? (
        data?.map((resource, index) => {
          const isFavorite = favoriteModels.find((id) => resource.modelId === id);
          return (
            <Wrapper resource={resource} key={resource.modelId ?? resource.modelName ?? index}>
              <Card p={8} sx={{ backgroundColor: theme.colors.dark[7] }} withBorder>
                <Stack spacing="xs">
                  <Group spacing={4} position="apart" noWrap>
                    <Text size="sm" weight={500} lineClamp={1}>
                      {resource.modelName ?? resource.name}
                    </Text>
                    {resource.modelType && (
                      <Badge radius="sm" size="sm">
                        {getDisplayName(resource.modelType)}
                      </Badge>
                    )}
                  </Group>
                  <Group spacing={0} position="apart">
                    <IconBadge
                      className={classes.statBadge}
                      sx={{ userSelect: 'none' }}
                      icon={
                        <Rating
                          size="xs"
                          value={resource.modelRating ?? 0}
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
                        color={(resource.modelRatingCount ?? 0) > 0 ? undefined : 'dimmed'}
                      >
                        {abbreviateNumber(resource.modelRatingCount ?? 0)}
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
                        <Text size="xs">{abbreviateNumber(resource.modelFavoriteCount ?? 0)}</Text>
                      </IconBadge>
                      <IconBadge
                        className={classes.statBadge}
                        icon={<IconMessageCircle2 size={14} />}
                      >
                        <Text size="xs">{abbreviateNumber(resource.modelCommentCount ?? 0)}</Text>
                      </IconBadge>
                      <IconBadge className={classes.statBadge} icon={<IconDownload size={14} />}>
                        <Text size={12}>{abbreviateNumber(resource.modelDownloadCount ?? 0)}</Text>
                      </IconBadge>
                    </Group>
                  </Group>
                </Stack>
              </Card>
            </Wrapper>
          );
        })
      ) : (
        <Alert>There are no resources associated with this image</Alert>
      )}
    </Stack>
  );
}

const Wrapper = ({
  resource,
  children,
}: {
  resource: ImageResourceModel;
  children: React.ReactElement;
}) => {
  if (resource.name) return children;
  return (
    <Link href={`/models/${resource.modelId}/${slugit(resource.modelName ?? '')}`} passHref>
      {cloneElement(children, { component: 'a' })}
    </Link>
  );
};
