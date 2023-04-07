import {
  ActionIcon,
  AspectRatio,
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
import { TooltipProps } from '@mantine/core/lib/Tooltip/Tooltip';
import { useListState } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import {
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconReload,
  IconSquareCheck,
  IconSquareOff,
  IconTag,
  IconTagOff,
  IconTrash,
} from '@tabler/icons';
import produce from 'immer';
import { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { ImageSort } from '~/server/common/enums';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { ImageGetInfinite } from '~/types/router';
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

const REMOVABLE_TAGS = ['child', 'teen', 'baby', 'girl', 'boy'];
const ADDABLE_TAGS = ['anime', 'cartoon', 'comics', 'manga', 'explicit nudity', 'suggestive'];

export default function Images() {
  const { ref, inView } = useInView();
  const queryUtils = trpc.useContext();
  const [selected, selectedHandlers] = useListState([] as number[]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching, refetch } =
    trpc.image.getInfinite.useInfiniteQuery(
      { needsReview: true, sort: ImageSort.Newest },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const moderateImagesMutation = trpc.image.moderate.useMutation({
    async onMutate({ ids, needsReview, delete: deleted }) {
      await queryUtils.image.getInfinite.cancel();
      queryUtils.image.getInfinite.setInfiniteData(
        { needsReview: true, sort: ImageSort.Newest },
        produce((data) => {
          if (!data?.pages?.length) return;

          for (const page of data.pages)
            for (const item of page.items) {
              if (ids.includes(item.id)) {
                item.needsReview = deleted === true || needsReview === false ? false : true;
              }
            }
        })
      );
    },
    onSuccess(_, input) {
      const actions: string[] = [];
      if (input.delete) actions.push('deleted');
      else if (!input.needsReview) actions.push('approved');
      else if (input.nsfw) actions.push('marked as NSFW');

      showSuccessNotification({ message: `The images have been ${actions.join(', ')}` });
    },
  });

  const disableTagMutation = trpc.tag.disableTags.useMutation();
  const addTagMutation = trpc.tag.addTags.useMutation();

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
            <Menu>
              <Menu.Target>
                <ButtonTooltip label="Add tag" {...tooltipProps}>
                  <ActionIcon variant="outline" disabled={!selected.length}>
                    <IconTag size="1.25rem" />
                  </ActionIcon>
                </ButtonTooltip>
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
                <ButtonTooltip label="Remove tag" {...tooltipProps}>
                  <ActionIcon variant="outline" disabled={!selected.length}>
                    <IconTagOff size="1.25rem" />
                  </ActionIcon>
                </ButtonTooltip>
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
              <ButtonTooltip label="Accept" {...tooltipProps}>
                <ActionIcon variant="outline" disabled={!selected.length} color="green">
                  <IconCheck size="1.25rem" />
                </ActionIcon>
              </ButtonTooltip>
            </PopConfirm>
            <PopConfirm
              message={`Are you sure you want to delete ${selected.length} image(s)?`}
              position="bottom-end"
              onConfirm={handleDeleteSelected}
              withArrow
            >
              <ButtonTooltip label="Delete" {...tooltipProps}>
                <ActionIcon variant="outline" disabled={!selected.length} color="red">
                  <IconTrash size="1.25rem" />
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

function ImageGridItem({ data: image, width: itemWidth, selected, onSelect }: ImageGridItemProps) {
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
                {image.postId && (
                  <Link href={`/posts/${image.postId}`} passHref legacyBehavior>
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
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetInfinite[number];
  index: number;
  width: number;
  selected: boolean;
  onSelect: (id: number, checked: boolean) => void;
  disableTag: (imageId: number, tagId: number) => void;
};
