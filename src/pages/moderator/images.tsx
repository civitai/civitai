import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Card,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconInfoCircle, IconRadar2, IconTrash } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { ConfirmButton } from '~/components/ConfirmButton/ConfirmButton';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageAnalysisPopover } from '~/components/Image/ImageAnalysis/ImageAnalysis';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import {
  ImageAnalysisInput,
  ImageMetaProps,
  ImageUpdateSchema,
} from '~/server/schema/image.schema';
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

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { needsReview: true },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );
  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  const onMutate = async ({ id }: { id: number }) => {
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
            item.id === id ? { ...item, needsReview: false } : item
          ),
        })),
      };
    });
  };

  const deleteImageMutation = trpc.image.delete.useMutation({
    onMutate,
    onSuccess() {
      showSuccessNotification({ message: 'The image has been deleted' });
    },
  });
  const updateImageMutation = trpc.image.update.useMutation({
    onMutate,
    onSuccess() {
      showSuccessNotification({ message: 'The image has been approved' });
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
            <Title order={1}>Images Needing Review</Title>
            <Text color="dimmed">
              These are images that have been marked by our AI which needs further attention from
              the mods
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
              isRefetching={isRefetching}
              isFetchingNextPage={isFetchingNextPage}
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

                <ImageAnalysisPopover analysis={image.analysis as ImageAnalysisInput}>
                  <ActionIcon
                    variant="transparent"
                    style={{ position: 'absolute', bottom: '5px', left: '5px' }}
                    size="lg"
                  >
                    <IconRadar2
                      color="white"
                      filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                      opacity={0.8}
                      strokeWidth={2.5}
                      size={26}
                    />
                  </ActionIcon>
                </ImageAnalysisPopover>
              </ImageGuard.Safe>
            </Box>
          )}
        />
      </Card.Section>
      <Group position="apart" pt="xs" noWrap grow>
        <ConfirmButton
          color="red"
          onConfirmed={() => onDeleteClick(image.id)}
          disabled={!image.needsReview}
          size="xs"
        >
          <IconTrash size={20} stroke={1.5} />
        </ConfirmButton>
        <Button
          color="green"
          onClick={() => {
            onUpdateClick({ id: image.id, needsReview: false });
          }}
          disabled={!image.needsReview}
          size="xs"
        >
          <IconCheck size={20} stroke={1.5} />
        </Button>
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
