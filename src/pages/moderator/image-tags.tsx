import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Card,
  Center,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  TooltipProps,
} from '@mantine/core';
import { useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconBan,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconX,
} from '@tabler/icons';
import { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageConnectionLink } from '~/components/Image/ImageConnectionLink/ImageConnectionLink';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { getTagDisplayName } from '~/libs/tags';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { ImageGetGalleryInfinite } from '~/types/router';
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

export default function ImageTags() {
  const { ref, inView } = useInView();
  const queryUtils = trpc.useContext();
  const [selected, selectedHandlers] = useListState([] as number[]);

  // TODO.images: Change endpoint to image.getInfinite
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching, refetch } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { tagReview: true },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const moderateTagsMutation = trpc.tag.moderateTags.useMutation({
    async onMutate({ entityIds, disable }) {
      await queryUtils.image.getGalleryImagesInfinite.cancel();
      queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ tagReview: true }, (data) => {
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
              !entityIds.includes(item.id)
                ? item
                : {
                    ...item,
                    tags: disable
                      ? item.tags.filter((tag) => !tag.needsReview)
                      : item.tags.map((tag) => ({ ...tag, needsReview: false })),
                  }
            ),
          })),
        };
      });
    },
  });

  const disableTagMutation = trpc.tag.disableTags.useMutation({
    async onMutate({ tags, entityIds }) {
      const isTagIds = typeof tags[0] === 'number';
      await queryUtils.image.getGalleryImagesInfinite.cancel();
      queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ tagReview: true }, (data) => {
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

  const handleSelectAll = () => {
    if (selected.length === images.length) handleClearAll();
    else selectedHandlers.setState(images.map((x) => x.id));
  };

  const handleClearAll = () => {
    selectedHandlers.setState([]);
  };

  const handleSelected = (disable: boolean) => {
    moderateTagsMutation.mutate(
      {
        entityIds: selected,
        entityType: 'image',
        disable,
      },
      {
        onSuccess: handleClearAll,
      }
    );
  };

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

  const tooltipProps: Omit<TooltipProps, 'label' | 'children'> = {
    position: 'bottom',
    withArrow: true,
    withinPortal: true,
  };

  return (
    <Container size="xl">
      <Stack>
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
            <ButtonTooltip label="Select all" {...tooltipProps}>
              <ActionIcon variant="outline" onClick={handleSelectAll}>
                <IconSquareCheck size="1.25rem" />
              </ActionIcon>
            </ButtonTooltip>
            <ButtonTooltip label="Clear selection" {...tooltipProps}>
              <ActionIcon variant="outline" disabled={!selected.length} onClick={handleClearAll}>
                <IconSquareOff size="1.25rem" />
              </ActionIcon>
            </ButtonTooltip>
            <PopConfirm
              message={`Are you sure you want to approve ${selected.length} tag removal(s)?`}
              position="bottom-end"
              onConfirm={() => handleSelected(true)}
              withArrow
            >
              <ButtonTooltip label="Approve selected" {...tooltipProps}>
                <ActionIcon variant="outline" disabled={!selected.length} color="green">
                  <IconCheck size="1.25rem" />
                </ActionIcon>
              </ButtonTooltip>
            </PopConfirm>
            <PopConfirm
              message={`Are you sure you want to decline ${selected.length} tag removal(s)?`}
              position="bottom-end"
              onConfirm={() => handleSelected(false)}
              withArrow
            >
              <ButtonTooltip label="Decline selected" {...tooltipProps}>
                <ActionIcon variant="outline" disabled={!selected.length} color="red">
                  <IconBan size="1.25rem" />
                </ActionIcon>
              </ButtonTooltip>
            </PopConfirm>
            <ButtonTooltip label="Refresh" {...tooltipProps}>
              <ActionIcon variant="outline" onClick={handleRefresh} color="blue">
                <IconReload size="1.25rem" />
              </ActionIcon>
            </ButtonTooltip>
          </Group>
        </Paper>

        <Stack spacing={0} mb="lg">
          <Title order={1}>Tags Needing Review</Title>
          <Text color="dimmed">
            These are images with moderation tags that users have voted to remove.
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
          <NoContent mt="lg" message="There are no tags that need review" />
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

  const tags = useMemo(
    () => ({
      toReview: image.tags.filter((x) => x.needsReview),
      other: image.tags.filter((x) => !x.needsReview),
    }),
    [image.tags]
  );
  const needsReview = tags.toReview.length > 0;

  const renderTag = (tag: (typeof tags.toReview)[number]) => {
    const isModeration = tag.type === 'Moderation';
    return (
      <Badge
        key={tag.id}
        variant={isModeration ? 'light' : 'filled'}
        color={isModeration ? 'red' : 'gray'}
        pr={0}
      >
        <Group spacing={0}>
          {getTagDisplayName(tag.name)}
          <ActionIcon size="sm" variant="transparent" onClick={() => disableTag(image.id, tag.id)}>
            <IconX strokeWidth={3} size=".75rem" />
          </ActionIcon>
        </Group>
      </Badge>
    );
  };

  return (
    <Card shadow="sm" p="xs" sx={{ opacity: !needsReview ? 0.2 : undefined }} withBorder>
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
                {image.postId && (
                  <Link href={`/posts/${image.postId}`} passHref>
                    <ActionIcon
                      component="a"
                      variant="transparent"
                      style={{ position: 'absolute', bottom: '5px', left: '5px' }}
                      size="lg"
                      target="_blank"
                    >
                      <IconExternalLink
                        color="white"
                        filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                        opacity={0.8}
                        strokeWidth={2.5}
                        size={26}
                      />
                    </ActionIcon>
                  </Link>
                )}
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
      {needsReview && (
        <>
          <Divider label="Pending removal" mt="xs" />
          <Group pt="xs" spacing={4}>
            {tags.toReview.map(renderTag)}
          </Group>
        </>
      )}
      <Divider label="Other tags" mt="xs" />
      <Group pt="xs" spacing={4}>
        {tags.other.map(renderTag)}
      </Group>
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetGalleryInfinite[number];
  index: number;
  width: number;
  selected: boolean;
  onSelect: (id: number, checked: boolean) => void;
  disableTag: (imageId: number, tagId: number) => void;
};
