import {
  ActionIcon,
  Alert,
  Badge,
  Card,
  CopyButton,
  Group,
  Rating,
  Skeleton,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDownload, IconHeart, IconMessageCircle2, IconStar, IconX } from '@tabler/icons';
import Link from 'next/link';
import { cloneElement, useMemo, useState } from 'react';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles(() => ({
  statBadge: {
    background: 'rgba(212,212,212,0.2)',
    color: 'white',
  },
}));

export function ImageResources({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const queryUtils = trpc.useContext();

  const [selectedResource, setSelectedResource] = useState<number | null>(null);

  const { data, isLoading } = trpc.image.getResources.useQuery({ id: imageId });

  const { data: { Favorite: favoriteModels = [] } = { Favorite: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  const resources = useMemo(() => {
    const resources =
      data
        ?.map((resource, index) => {
          const isFavorite = favoriteModels.find((id) => resource.modelId === id);
          const isAvailable = resource.modelVersionId !== null;
          return {
            ...resource,
            key: resource.modelVersionId ?? resource.modelName ?? index,
            isFavorite,
            isAvailable,
          };
        })
        .sort((a, b) => {
          if (a.isAvailable && !b.isAvailable) return -1;
          if (!a.isAvailable && b.isAvailable) return 1;
          if (a.isFavorite && !b.isFavorite) return -1;
          if (!a.isFavorite && b.isFavorite) return 1;
          return 0;
        }) ?? [];
    return resources;
  }, [data, favoriteModels]);

  const { mutate, isLoading: removingResource } = trpc.image.removeResource.useMutation();
  const handleRemoveResource = (resourceId: number) => {
    setSelectedResource(resourceId);
    openConfirmModal({
      centered: true,
      title: 'Remove Resource',
      children:
        'Are you sure you want to remove this resource from this image? This action is destructive and cannot be reverted.',
      labels: { confirm: 'Yes, remove it', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        mutate(
          { imageId, resourceId },
          {
            async onSuccess() {
              showSuccessNotification({
                title: 'Successfully removed resource',
                message: 'The resource was removed from the image',
              });
              await queryUtils.image.getResources.invalidate({ id: imageId });
            },
            onError(error) {
              showErrorNotification({
                title: 'Unable to remove resource',
                error: new Error(error.message),
              });
            },
            onSettled() {
              setSelectedResource(null);
            },
          }
        ),
    });
  };

  return (
    <Stack spacing={4}>
      {isLoading ? (
        <Stack spacing="xs">
          <Skeleton height={16} radius="md" />
          <Skeleton height={16} radius="md" />
        </Stack>
      ) : !!resources.length ? (
        resources.map(({ key, isFavorite, isAvailable, ...resource }) => {
          const removing = selectedResource === resource.id && removingResource;

          return (
            <Wrapper resource={resource} key={key}>
              <Card
                p={8}
                sx={{
                  backgroundColor: theme.colors.dark[7],
                  opacity: removing ? 0.3 : isAvailable ? 1 : 0.3,
                }}
                withBorder
              >
                <Stack spacing="xs">
                  <Group spacing={4} position="apart" noWrap>
                    <Text size="sm" weight={500} lineClamp={1}>
                      {resource.modelName ?? resource.name}
                    </Text>
                    {!isAvailable && (
                      <Badge radius="sm" size="sm" color="yellow">
                        Unavailable
                      </Badge>
                    )}
                    <Group spacing={4}>
                      {resource.modelType && (
                        <Badge radius="sm" size="sm">
                          {getDisplayName(resource.modelType)}
                        </Badge>
                      )}
                      {!isAvailable && resource.hash && (
                        <CopyButton value={resource.hash}>
                          {({ copy, copied }) => (
                            <Badge onClick={copy} radius="sm" size="sm" sx={{ cursor: 'pointer' }}>
                              {copied ? 'Copied...' : resource.hash}
                            </Badge>
                          )}
                        </CopyButton>
                      )}
                      {currentUser?.isModerator && (
                        <ActionIcon
                          size="xs"
                          color="red"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            e.nativeEvent.stopImmediatePropagation();

                            handleRemoveResource(resource.id);
                          }}
                          disabled={removing}
                        >
                          <IconX size={14} stroke={1.5} />
                        </ActionIcon>
                      )}
                    </Group>
                  </Group>
                  {isAvailable && (
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
                          <Text size="xs">
                            {abbreviateNumber(resource.modelFavoriteCount ?? 0)}
                          </Text>
                        </IconBadge>
                        <IconBadge
                          className={classes.statBadge}
                          icon={<IconMessageCircle2 size={14} />}
                        >
                          <Text size="xs">{abbreviateNumber(resource.modelCommentCount ?? 0)}</Text>
                        </IconBadge>
                        <IconBadge className={classes.statBadge} icon={<IconDownload size={14} />}>
                          <Text size={12}>
                            {abbreviateNumber(resource.modelDownloadCount ?? 0)}
                          </Text>
                        </IconBadge>
                      </Group>
                    </Group>
                  )}
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
  resource: { modelId: number | null; modelName: string | null; modelVersionId: number | null };
  children: React.ReactElement;
}) => {
  if (!resource.modelId) return children;
  return (
    <Link
      href={`/models/${resource.modelId}/${slugit(resource.modelName ?? '')}?modelVersionId=${
        resource.modelVersionId
      }`}
      passHref
    >
      {cloneElement(children, { component: 'a' })}
    </Link>
  );
};
