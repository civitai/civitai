import {
  ActionIcon,
  Button,
  ContainerProps,
  Group,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { CollectionType } from '@prisma/client';
import {
  IconCloudOff,
  IconDotsVertical,
  IconHome,
  IconPencil,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { AddUserContentModal } from '~/components/Collections/AddUserContentModal';
import { CollectionFollowAction } from '~/components/Collections/components/CollectionFollow';
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
import { constants } from '~/server/common/constants';
import { CollectionByIdModel } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification } from '~/utils/notifications';

const ModelCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...queryFilters } = useModelQueryParams();

  return (
    <IsClient>
      <Group position="apart" spacing={0}>
        <Group>
          <SortFilter type="models" />
        </Group>
        <Group spacing={4}>
          <PeriodFilter type="models" />
          <ModelFiltersDropdown />
        </Group>
      </Group>
      <CategoryTags />
      <ModelsInfinite
        filters={{
          ...queryFilters,
          collectionId: collection.id,
        }}
      />
    </IsClient>
  );
};

const ImageCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { ...queryFilters } = useImageQueryParams();

  return (
    <IsClient>
      <Group position="apart" spacing={0}>
        <Group>
          <SortFilter type="images" />
        </Group>
        <Group spacing={4}>
          <PeriodFilter type="images" />
        </Group>
      </Group>
      <CategoryTags />
      <ImagesInfinite
        filters={{
          ...queryFilters,
          collectionId: collection.id,
        }}
        withTags
      />
    </IsClient>
  );
};
const PostCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...queryFilters } = usePostQueryParams();

  return (
    <IsClient>
      <Group position="apart" spacing={0}>
        <Group>
          <SortFilter type="posts" />
        </Group>
        <Group spacing={4}>
          <PeriodFilter type="posts" />
        </Group>
      </Group>
      <CategoryTags />
      <PostsInfinite
        filters={{
          ...queryFilters,
          collectionId: collection.id,
        }}
      />
    </IsClient>
  );
};

const ArticleCollection = ({ collection }: { collection: NonNullable<CollectionByIdModel> }) => {
  const { set, ...queryFilters } = useArticleQueryParams();

  return (
    <IsClient>
      <Group position="apart" spacing={0}>
        <Group>
          <SortFilter type="articles" />
        </Group>
        <Group spacing={4}>
          <PeriodFilter type="articles" />
        </Group>
      </Group>
      <CategoryTags />
      <ArticlesInfinite
        filters={{
          ...queryFilters,
          collectionId: collection.id,
        }}
      />
    </IsClient>
  );
};

export function Collection({
  collectionId,
  ...containerProps
}: { collectionId: number } & Omit<ContainerProps, 'children'>) {
  const [opened, setOpened] = useState(false);
  const utils = trpc.useContext();
  const user = useCurrentUser();

  const { data: { collection, permissions } = {}, isLoading } = trpc.collection.getById.useQuery({
    id: collectionId,
  });
  // Using this query might be more performant all together as there is a high likelyhood
  // that it's been preloaded by the user.
  const { data: homeBlocks = [] } = trpc.homeBlock.getHomeBlocks.useQuery();
  const collectionHomeBlock = useMemo(() => {
    if (!user) {
      return null;
    }

    return homeBlocks.find((homeBlock) => {
      const metadata = homeBlock.metadata as HomeBlockMetaSchema;
      return metadata.collection?.id === collectionId && homeBlock.userId === user.id;
    });
  }, [homeBlocks, collectionId, user]);

  const createCollectionHomeBlock = trpc.homeBlock.createCollectionHomeBlock.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Home page has been updated',
        message: `This collection has been added to your home page`,
      });
      await utils.homeBlock.getHomeBlocks.invalidate();
    },
  });
  const deleteHomeBlock = trpc.homeBlock.delete.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Home page has been updated',
        message: `Collection has been removed from your home page`,
      });
      await utils.homeBlock.getHomeBlocks.invalidate();
    },
  });

  const onToggleCollectionHomeBlock = async () => {
    if (!collectionHomeBlock) {
      await createCollectionHomeBlock.mutate({
        collectionId: collectionId,
      });
    } else {
      await deleteHomeBlock.mutate({
        id: collectionHomeBlock.id,
      });
    }
  };

  // createCollectionHomeBlock

  if (!isLoading && !collection) {
    return (
      <Stack w="100%" align="center">
        <Stack spacing="md" align="center" maw={800}>
          <Title order={1} lh={1}>
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
        <MasonryContainer {...containerProps}>
          <Stack spacing="xs" w="100%">
            <Group align="center" spacing="xs" position="apart" noWrap>
              <Stack spacing={0}>
                <Title order={1} lineClamp={1}>
                  {collection?.name ?? 'Loading...'}
                </Title>
                {collection?.description && (
                  <Text size="xs" color="dimmed">
                    {collection.description}
                  </Text>
                )}
              </Stack>
              {collection && permissions && (
                <Group ml="auto">
                  <CollectionFollowAction collection={collection} permissions={permissions} />
                  {canAddContent && (
                    <Button
                      size="xs"
                      variant="outline"
                      pl={4}
                      pr={8}
                      onClick={() => setOpened(true)}
                    >
                      <Group spacing={4}>
                        <IconPlaylistAdd size={18} />
                        Add from your library
                      </Group>
                    </Button>
                  )}
                  {user && (
                    <Menu>
                      <Menu.Target>
                        <ActionIcon variant="outline">
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      {(permissions.read || permissions.manage) && (
                        <Menu.Dropdown>
                          {permissions.read && (
                            <Menu.Item
                              icon={<IconHome size={14} stroke={1.5} />}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onToggleCollectionHomeBlock();
                              }}
                            >
                              {collectionHomeBlock ? 'Remove from my home' : 'Add to my home'}
                            </Menu.Item>
                          )}
                          {permissions.manage && (
                            <Menu.Item
                              component={NextLink}
                              icon={<IconPencil size={14} stroke={1.5} />}
                              href={`/collections/${collection.id}/review`}
                            >
                              Review Items
                            </Menu.Item>
                          )}
                        </Menu.Dropdown>
                      )}
                    </Menu>
                  )}
                </Group>
              )}
            </Group>
            {collection && collectionType === CollectionType.Model && (
              <ModelCollection collection={collection} />
            )}
            {collection && collectionType === CollectionType.Image && (
              <ImageCollection collection={collection} />
            )}
            {collection && collectionType === CollectionType.Post && (
              <PostCollection collection={collection} />
            )}
            {collection && collectionType === CollectionType.Article && (
              <ArticleCollection collection={collection} />
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
