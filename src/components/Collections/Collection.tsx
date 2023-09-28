import {
  ActionIcon,
  AspectRatio,
  Box,
  Center,
  ContainerProps,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  createStyles,
  Menu,
} from '@mantine/core';
import { CollectionContributorPermission, CollectionType, MetricTimeframe } from '@prisma/client';
import {
  IconCirclePlus,
  IconCloudOff,
  IconDotsVertical,
  IconPhoto,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import React, { useState } from 'react';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { AddUserContentModal } from '~/components/Collections/AddUserContentModal';
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { CollectionByIdModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { ArticleSort, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import { ArticleCategories } from '~/components/Article/Infinite/ArticleCategories';
import { ImageGuardReportContext } from '~/components/ImageGuard/ImageGuard';
import { CollectionContributorPermissionFlags } from '~/server/services/collection.service';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { openContext } from '~/providers/CustomModalsProvider';
import { ImageUploadProps } from '~/server/schema/image.schema';
import { showSuccessNotification } from '~/utils/notifications';

const ModelCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...query } = useModelQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ModelSort.Newest;

  return (
    <Stack spacing="xs">
      <IsClient>
        <Group position="apart" spacing={0}>
          <SortFilter type="models" value={sort} onChange={(x) => set({ sort: x as ModelSort })} />
          <Group spacing="xs">
            <PeriodFilter type="models" value={period} onChange={(x) => set({ period: x })} />
            <ModelFiltersDropdown />
          </Group>
        </Group>
        <CategoryTags />
        <ModelsInfinite
          filters={{
            ...query,
            period,
            sort,
            collectionId: collection.id,
          }}
        />
      </IsClient>
    </Stack>
  );
};

const ImageCollection = ({
  collection,
  permissions,
}: {
  collection: NonNullable<CollectionByIdModel>;
  permissions?: CollectionContributorPermissionFlags;
}) => {
  const { replace, query } = useImageQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ImageSort.Newest;
  const updateCollectionCoverImageMutation = trpc.collection.updateCoverImage.useMutation();
  const utils = trpc.useContext();

  return (
    <ImageGuardReportContext.Provider
      value={{
        getMenuItems: ({ menuItems, ...image }) => {
          const items = menuItems.map((item) => item.component);
          if (!permissions || !permissions.manage || !image.id) {
            return items;
          }

          const useAsCover = (
            <Menu.Item
              key="make-cover-photo"
              icon={
                // @ts-ignore: transparent variant actually works here.
                <ThemeIcon color="pink.7" variant="transparent" size="sm">
                  <IconPhoto size={16} stroke={1.5} />
                </ThemeIcon>
              }
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                updateCollectionCoverImageMutation.mutate(
                  {
                    id: collection.id,
                    imageId: image.id,
                  },
                  {
                    onSuccess: async () => {
                      showSuccessNotification({
                        title: 'Cover image updated',
                        message: 'Collection cover image has been updated',
                      });
                      await utils.collection.getById.invalidate({ id: collection.id });
                    },
                  }
                );
              }}
            >
              Use as cover image
            </Menu.Item>
          );

          return [useAsCover, ...items];
        },
      }}
    >
      <Stack spacing="xs">
        <IsClient>
          <Group position="apart" spacing={0}>
            <SortFilter
              type="images"
              value={sort}
              onChange={(x) => replace({ sort: x as ImageSort })}
            />
            <PeriodFilter type="images" value={period} onChange={(x) => replace({ period: x })} />
          </Group>
          <ImageCategories />
          <ImagesInfinite
            filters={{
              ...query,
              period,
              sort,
              collectionId: collection.id,
              types: undefined,
              withMeta: undefined,
            }}
          />
        </IsClient>
      </Stack>
    </ImageGuardReportContext.Provider>
  );
};
const PostCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...query } = usePostQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? PostSort.Newest;

  return (
    <Stack spacing="xs">
      <IsClient>
        <Group position="apart" spacing={0}>
          <SortFilter type="posts" value={sort} onChange={(sort) => set({ sort: sort as any })} />
          <PeriodFilter type="posts" value={period} onChange={(period) => set({ period })} />
        </Group>
        <PostCategories />
        <PostsInfinite
          filters={{
            ...query,
            period,
            sort,
            collectionId: collection.id,
          }}
        />
      </IsClient>
    </Stack>
  );
};

const ArticleCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...query } = useArticleQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ArticleSort.Newest;

  return (
    <Stack spacing="xs">
      <IsClient>
        <Group position="apart" spacing={0}>
          <SortFilter
            type="articles"
            value={sort}
            onChange={(x) => set({ sort: x as ArticleSort })}
          />
          <PeriodFilter type="articles" value={period} onChange={(x) => set({ period: x })} />
        </Group>
        <ArticleCategories />
        <ArticlesInfinite
          filters={{
            ...query,
            period,
            sort,
            collectionId: collection.id,
          }}
        />
      </IsClient>
    </Stack>
  );
};

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const { classes } = useStyles();
  const [opened, setOpened] = useState(false);

  const { data: { collection, permissions } = {}, isLoading } = trpc.collection.getById.useQuery({
    id: collectionId,
  });

  if (!isLoading && !collection) {
    return (
      <Stack w="100%" align="center">
        <Stack spacing="md" align="center" maw={800}>
          <Title order={1} inline>
            Whoops!
          </Title>
          <Text align="center">
            It looks like you landed on the wrong place.The collection you are trying to access does
            not exist or you do not have the sufficient permissions to see it.
          </Text>
          <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
            <IconCloudOff size={80} />
          </ThemeIcon>
        </Stack>
      </Stack>
    );
  }

  const collectionType = collection?.type;
  // TODO.collections: This is tied to images for now but
  // we will need to add a check for other resources later
  const canAddContent =
    collectionType === CollectionType.Image && (permissions?.write || permissions?.writeReview);

  return (
    <>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer {...containerProps} p={0}>
          <Stack spacing="xl" w="100%">
            <Group spacing="xl">
              {collection?.image && (
                <Box
                  w={220}
                  sx={(theme) => ({
                    overflow: 'hidden',
                    borderRadius: '8px',
                    boxShadow: theme.shadows.md,
                    [theme.fn.smallerThan('sm')]: { width: '100%', marginBottom: theme.spacing.xs },
                  })}
                >
                  <AspectRatio ratio={3 / 2}>
                    <EdgeMedia
                      className={classes.coverImage}
                      src={collection.image.url}
                      type={collection.image.type}
                      name={collection.image.name ?? collection.image.url}
                      alt={collection.image.name ?? undefined}
                      width={collection.image.width ?? 1200}
                      loading="lazy"
                    />
                  </AspectRatio>
                </Box>
              )}
              <Stack spacing={8} sx={{ flex: 1 }}>
                <Stack spacing={0}>
                  <Title
                    order={1}
                    lineClamp={1}
                    sx={(theme) => ({
                      [theme.fn.smallerThan('sm')]: {
                        fontSize: '28px',
                      },
                    })}
                  >
                    {collection?.name ?? 'Loading...'}
                  </Title>
                  {collection?.description && (
                    <Text size="xs" color="dimmed">
                      {collection.description}
                    </Text>
                  )}
                </Stack>
                {collection && (
                  <Group spacing={4} noWrap>
                    {collection.user.id !== -1 && (
                      <UserAvatar user={collection.user} withUsername linkToProfile />
                    )}
                    {/* TODO.collections: We need some metrics to actually display these badges */}
                    {/* <IconBadge className={classes.iconBadge} icon={<IconLayoutGrid size={14} />}>
                      <Text size="xs">{abbreviateNumber(data._count.items)}</Text>
                    </IconBadge>
                    <IconBadge className={classes.iconBadge} icon={<IconUser size={14} />}>
                      <Text size="xs">{abbreviateNumber(data._count.contributors)}</Text>
                    </IconBadge> */}
                  </Group>
                )}
              </Stack>
              {collection && permissions && (
                <Group spacing={4} ml="auto" sx={{ alignSelf: 'flex-start' }} noWrap>
                  <CollectionFollowAction collection={collection} permissions={permissions} />
                  {canAddContent && (
                    <Tooltip label="Add from your library" position="bottom" withArrow>
                      <ActionIcon
                        color="blue"
                        variant="subtle"
                        radius="xl"
                        onClick={() => setOpened(true)}
                      >
                        <IconCirclePlus />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <CollectionContextMenu
                    collectionId={collection.id}
                    ownerId={collection.user.id}
                    permissions={permissions}
                  >
                    <ActionIcon variant="subtle">
                      <IconDotsVertical size={16} />
                    </ActionIcon>
                  </CollectionContextMenu>
                </Group>
              )}
            </Group>
            {collection && collectionType === CollectionType.Model && (
              <ModelCollection collection={collection} />
            )}
            {collection && collectionType === CollectionType.Image && (
              <ImageCollection collection={collection} permissions={permissions} />
            )}
            {collection && collectionType === CollectionType.Post && (
              <PostCollection collection={collection} />
            )}
            {collection && collectionType === CollectionType.Article && (
              <ArticleCollection collection={collection} />
            )}
            {!collectionType && !isLoading && (
              <Center py="xl">
                <Stack spacing="xs">
                  <Text size="lg" weight="700" align="center">
                    Whoops!
                  </Text>
                  <Text align="center">This collection type is not supported</Text>
                </Stack>
              </Center>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
      {collection && canAddContent && (
        <AddUserContentModal
          collectionId={collection.id}
          opened={opened}
          onClose={() => setOpened(false)}
        />
      )}
    </>
  );
}

const useStyles = createStyles(() => ({
  coverImage: {
    objectPosition: 'top center',
  },
}));
