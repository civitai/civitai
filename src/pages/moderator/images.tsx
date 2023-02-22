import {
  ActionIcon,
  AspectRatio,
  Box,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { IconCheck, IconTrash } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { ImageUpdateSchema } from '~/server/schema/image.schema';
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

export default function Images() {
  const { ref, inView } = useInView();
  const queryUtils = trpc.useContext();

  const { data, isLoading, fetchNextPage, hasNextPage, isFetching } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { needsReview: true },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const previousFetching = usePrevious(isFetching);

  const onMutate = async ({ id }: { id: number }) => {
    await queryUtils.image.getGalleryImagesInfinite.cancel();
    queryUtils.image.getGalleryImagesInfinite.setInfiniteData({ needsReview: false }, (data) => {
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
            item.id === id ? { ...item, needsReview: false } : item
          ),
        })),
      };
    });
  };

  const deleteImageMutation = trpc.image.delete.useMutation({
    onMutate,
    onSuccess() {
      showSuccessNotification({ message: 'The image has been updated' });
    },
  });
  const updateImageMutation = trpc.image.update.useMutation({
    onMutate,
    onSuccess() {
      showSuccessNotification({ message: 'The image has been deleted' });
    },
  });

  const handleDelete = (id: number) => {
    deleteImageMutation.mutate({ id });
  };
  const handleUpdate = (image: ImageUpdateSchema) => {
    updateImageMutation.mutate(image);
  };

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  return (
    <Container size="xl">
      <Grid gutter="xl">
        <Grid.Col>
          <Stack spacing={0}>
            <Title order={1}>Classified Images</Title>
            <Text color="dimmed">
              These are images that have been marked by our AI as NSFW which needs further attention
              from the mods
            </Text>
          </Stack>
        </Grid.Col>
        <Grid.Col>
          {isLoading ? (
            <Center py="xl">
              <Loader size="xl" />
            </Center>
          ) : images.length ? (
            <MasonryGrid
              items={images}
              previousFetching={previousFetching}
              render={(props) => (
                <ImageGridItem
                  {...props}
                  onDeleteClick={handleDelete}
                  onUpdateClick={handleUpdate}
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
        </Grid.Col>
      </Grid>
    </Container>
  );
}

function ImageGridItem({
  data: image,
  width: itemWidth,
  onDeleteClick,
  onUpdateClick,
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
                  alt={image.name ?? undefined}
                  width={450}
                  placeholder="empty"
                />
              </ImageGuard.Safe>
            </Box>
          )}
        />
      </Card.Section>
      <Group position="apart" pt="xs" noWrap grow>
        <Tooltip label="Delete Image">
          <ActionIcon
            variant="filled"
            color="red"
            onClick={() => {
              openConfirmModal({
                title: 'Delete Image',
                children: 'Are you sure you want to delete this image?',
                centered: true,
                onConfirm: () => {
                  onDeleteClick(image.id);
                },
                labels: { confirm: 'Yes, delete it', cancel: 'Cancel' },
                confirmProps: { color: 'red' },
              });
            }}
            disabled={!image.needsReview}
          >
            <IconTrash size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Accept Image">
          <ActionIcon
            variant="filled"
            color="green"
            onClick={() => {
              onUpdateClick({ id: image.id, needsReview: false });
            }}
            disabled={!image.needsReview}
          >
            <IconCheck size={20} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetAllInfinite[number];
  index: number;
  width: number;
  onDeleteClick: (id: number) => void;
  onUpdateClick: (image: ImageUpdateSchema) => void;
};
