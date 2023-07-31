import {
  ActionIcon,
  Button,
  ContainerProps,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { CollectionType } from '@prisma/client';
import { IconCloudOff, IconDotsVertical, IconPlaylistAdd } from '@tabler/icons-react';
import { useState } from 'react';
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
import { CollectionContextMenu } from '~/components/Collections/components/CollectionContextMenu';

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
                  <CollectionContextMenu
                    collectionId={collection.id}
                    ownerId={collection.userId}
                    permissions={permissions}
                  >
                    <ActionIcon variant="outline">
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
