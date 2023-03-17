import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  Checkbox,
  Container,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconCheck,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTag,
  IconTagOff,
  IconTrash,
  IconX,
} from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useEffect, useMemo, useRef } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { ImageGetAllInfinite } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerAuthSession(context);
  if (!session?.user?.isModerator || session.user?.bannedAt) {
    return {
      redirect: {
        destination: '/',
        permanent: false,
      },
    };
  }
  return { props: {} };
};

const REMOVABLE_TAGS = ['child', 'teen'];
const ADDABLE_TAGS = ['anime', 'cartoon', 'comics', 'manga', 'explicit nudity', 'suggestive'];

export default function Images() {
  const { ref, inView } = useInView();
  const queryUtils = trpc.useContext();
  const [selected, selectedHandlers] = useListState([] as number[]);
  const stackRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching, refetch } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { needsReview: true },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const moderateImagesMutation = trpc.image.moderate.useMutation({
    async onMutate({ ids, needsReview, delete: deleted }) {
      await queryUtils.image.getGalleryImagesInfinite.cancel();
      queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ needsReview: true }, (data) => {
        if (!data) {
          return {
            pages: [],
            pageParams: [],
          };
        }

        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              ids.includes(item.id)
                ? { ...item, needsReview: deleted === true || needsReview === false ? false : true }
                : item
            ),
          })),
        };
      });
    },
    onSuccess(_, input) {
      const actions: string[] = [];
      if (input.delete) actions.push('deleted');
      else if (!input.needsReview) actions.push('approved');
      else if (input.nsfw) actions.push('marked as NSFW');

      showSuccessNotification({ message: `The images have been ${actions.join(', ')}` });
    },
  });

  const disableTagMutation = trpc.tag.disableTags.useMutation({
    async onMutate({ tags, entityIds }) {
      const isTagIds = typeof tags[0] === 'number';
      await queryUtils.image.getGalleryImagesInfinite.cancel();
      queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ needsReview: true }, (data) => {
        if (!data) {
          return {
            pages: [],
            pageParams: [],
          };
        }

        // Remove tag from selected images
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              entityIds.includes(item.id)
                ? {
                    ...item,
                    tags: item.tags.filter(
                      (tag) => !tags.some((x) => (isTagIds ? x === tag.id : x === tag.name))
                    ),
                  }
                : item
            ),
          })),
        };
      });
    },
  });

  const addTagMutation = trpc.tag.addTags.useMutation({
    async onMutate({ tags, entityIds }) {
      const isTagIds = typeof tags[0] === 'number';
      await queryUtils.image.getGalleryImagesInfinite.cancel();

      queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ needsReview: true }, (data) => {
        if (!data) {
          return {
            pages: [],
            pageParams: [],
          };
        }

        // Add tag to selected images
        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              entityIds.includes(item.id)
                ? {
                    ...item,
                    tags: [
                      ...item.tags,
                      ...tags.map((x) => ({
                        id: isTagIds ? (x as number) : 0,
                        name: !isTagIds ? (x as string) : '',
                        automated: false,
                        isCategory: false,
                      })),
                    ],
                  }
                : item
            ),
          })),
        };
      });
    },
  });

  const handleSelect = (id: number, checked: boolean) => {
    const idIndex = selected.indexOf(id);
    if (checked && idIndex == -1) selectedHandlers.append(id);
    else if (!checked && idIndex != -1) selectedHandlers.remove(idIndex);
  };

  const handleDisableTagOnImage = (imageId: number, tag: number) =>
    disableTagMutation.mutate({
      tags: [tag],
      entityIds: [imageId],
      entityType: 'image',
    });

  const handleDeleteSelected = () => {
    moderateImagesMutation.mutate({
      ids: selected,
      delete: true,
    });
    selectedHandlers.setState([]);
  };

  const handleSelectAll = () => {
    if (selected.length === images.length) handleClearAll();
    else selectedHandlers.setState(images.map((x) => x.id));
  };

  const handleClearAll = () => {
    selectedHandlers.setState([]);
  };

  const handleApproveSelected = () =>
    moderateImagesMutation.mutate({
      ids: selected,
      needsReview: false,
    });

  const handleAddTag = (tag: string) =>
    addTagMutation.mutate({
      tags: [tag],
      entityIds: selected,
      entityType: 'image',
    });

  const handleDisableTag = (tag: string) =>
    disableTagMutation.mutate({
      tags: [tag],
      entityIds: selected,
      entityType: 'image',
    });

  const handleRefresh = () => {
    handleClearAll();
    refetch();
    showNotification({
      id: 'refreshing',
      title: 'Refreshing',
      message: 'Grabbing the latest data...',
      color: 'blue',
    });
  };

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  return (
    <Container size="xl">
      <Stack ref={stackRef}>
        <Paper
          withBorder
          shadow="lg"
          p="xs"
          sx={{
            display: 'inline-flex',
            float: 'right',
            alignSelf: 'flex-end',
            marginRight: 6,
            position: 'sticky',
            top: 'calc(var(--mantine-header-height,0) + 16px)',
            marginBottom: -80,
            zIndex: 10,
          }}
        >
          <Group noWrap spacing="xs">
            <ActionIcon variant="outline" onClick={handleSelectAll}>
              <IconSquareCheck size="1.25rem" />
            </ActionIcon>
            <ActionIcon variant="outline" disabled={!selected.length} onClick={handleClearAll}>
              <IconSquareOff size="1.25rem" />
            </ActionIcon>
            <Menu>
              <Menu.Target>
                <ActionIcon variant="outline" disabled={!selected.length}>
                  <IconTag size="1.25rem" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Add Tag</Menu.Label>
                {ADDABLE_TAGS.map((tag) => (
                  <Menu.Item key={tag} onClick={() => handleAddTag(tag)}>
                    {tag}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <Menu>
              <Menu.Target>
                <ActionIcon variant="outline" disabled={!selected.length}>
                  <IconTagOff size="1.25rem" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Remove Tag</Menu.Label>
                {REMOVABLE_TAGS.map((tag) => (
                  <Menu.Item key={tag} onClick={() => handleDisableTag(tag)}>
                    {tag}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
            <PopConfirm
              message={`Are you sure you want to approve ${selected.length} image(s)?`}
              position="bottom-end"
              onConfirm={handleApproveSelected}
              withArrow
            >
              <ActionIcon variant="outline" disabled={!selected.length} color="green">
                <IconCheck size="1.25rem" />
              </ActionIcon>
            </PopConfirm>
            <PopConfirm
              message={`Are you sure you want to delete ${selected.length} image(s)?`}
              position="bottom-end"
              onConfirm={handleDeleteSelected}
              withArrow
            >
              <ActionIcon variant="outline" disabled={!selected.length} color="red">
                <IconTrash size="1.25rem" />
              </ActionIcon>
            </PopConfirm>
            <ActionIcon variant="outline" onClick={handleRefresh} color="blue">
              <IconReload size="1.25rem" />
            </ActionIcon>
          </Group>
        </Paper>

        <Stack spacing={0} mb="lg">
          <Title order={1}>Images Needing Review</Title>
          <Text color="dimmed">
            These are images that have been marked by our AI which needs further attention from the
            mods
          </Text>
        </Stack>

        {isLoading ? (
          <Center py="xl">
            <Loader size="xl" />
          </Center>
        ) : images.length ? (
          <MasonryGrid
            items={images}
            isRefetching={isRefetching}
            isFetchingNextPage={isFetchingNextPage}
            render={(props) => (
              <ImageGridItem
                {...props}
                selected={selected.includes(props.data.id)}
                onSelect={handleSelect}
                disableTag={handleDisableTagOnImage}
              />
            )}
          />
        ) : (
          <NoContent mt="lg" message="There are no images that need review" />
        )}
        {!isLoading && hasNextPage && (
          <Group position="center" ref={ref}>
            <Loader />
          </Group>
        )}
      </Stack>
    </Container>
  );
}

function ImageGridItem({
  data: image,
  width: itemWidth,
  selected,
  onSelect,
  disableTag,
}: ImageGridItemProps) {
  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [itemWidth, image.width, image.height]);

  return (
    <Card
      shadow="sm"
      p="xs"
      sx={{ opacity: image.needsReview === false ? 0.2 : undefined }}
      withBorder
    >
      <Card.Section sx={{ height: `${height}px` }}>
        <Checkbox
          checked={selected}
          onChange={(e) => onSelect(image.id, e.target.checked)}
          size="lg"
          sx={{
            position: 'absolute',
            top: 5,
            right: 5,
            zIndex: 9,
          }}
        />
        <ImageGuard
          images={[image]}
          render={(image) => (
            <Box sx={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
              <ImageGuard.ToggleImage
                sx={(theme) => ({
                  backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                  color: 'white',
                  backdropFilter: 'blur(7px)',
                  boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                  position: 'absolute',
                  top: theme.spacing.xs,
                  left: theme.spacing.xs,
                  zIndex: 10,
                })}
                position="static"
              />
              <ImageGuard.Unsafe>
                <AspectRatio ratio={(image.width ?? 1) / (image.height ?? 1)}>
                  <MediaHash {...image} />
                </AspectRatio>
              </ImageGuard.Unsafe>
              <ImageGuard.Safe>
                <EdgeImage
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  width={450}
                  placeholder="empty"
                />
                {image.meta && (
                  <ImageMetaPopover
                    meta={image.meta as ImageMetaProps}
                    generationProcess={image.generationProcess ?? 'txt2img'}
                  >
                    <ActionIcon
                      variant="transparent"
                      style={{ position: 'absolute', bottom: '5px', right: '5px' }}
                      size="lg"
                    >
                      <IconInfoCircle
                        color="white"
                        filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                        opacity={0.8}
                        strokeWidth={2.5}
                        size={26}
                      />
                    </ActionIcon>
                  </ImageMetaPopover>
                )}
              </ImageGuard.Safe>
            </Box>
          )}
        />
      </Card.Section>
      <Group pt="xs" spacing={4}>
        {image.tags.map((tag) => (
          <Badge key={tag.id} variant="filled" color="gray" pr={0}>
            <Group spacing={0}>
              {tag.name}
              <ActionIcon
                size="sm"
                variant="transparent"
                onClick={() => disableTag(image.id, tag.id)}
              >
                <IconX strokeWidth={3} size=".75rem" />
              </ActionIcon>
            </Group>
          </Badge>
        ))}
      </Group>
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetAllInfinite[number];
  index: number;
  width: number;
  selected: boolean;
  onSelect: (id: number, checked: boolean) => void;
  disableTag: (imageId: number, tagId: number) => void;
};
