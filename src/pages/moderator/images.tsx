import {
  ActionIcon,
  AspectRatio,
  Box,
  Card,
  Center,
  Container,
  Group,
  Loader,
  Menu,
} from '@mantine/core';
import { IconCheck, IconDotsVertical, IconFlag, IconTrash } from '@tabler/icons';
import { GetServerSideProps } from 'next';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import {
  GalleryCategories,
  GalleryFilters,
  GalleryPeriod,
  GallerySort,
  useGalleryFilters,
} from '~/components/Gallery/GalleryFilters';
import { ReportImageButton } from '~/components/Gallery/ReportImageButton';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryGrid } from '~/components/MasonryGrid/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { ImageGetAllInfinite } from '~/types/router';
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
  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(
      { needsReview: false },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );
  const images = useMemo(
    () => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [],
    [data?.pages]
  );

  useEffect(() => {
    if (inView) fetchNextPage();
  }, [fetchNextPage, inView]);

  return (
    <Container>
      {isLoading ? (
        <Center py="xl">
          <Loader size="xl" />
        </Center>
      ) : images.length ? (
        <MasonryGrid items={images} render={ImageGridItem} />
      ) : (
        <NoContent mt="lg" />
      )}
      {!isLoading && hasNextPage && (
        <Group position="center" ref={ref}>
          <Loader />
        </Group>
      )}
    </Container>
  );
}

function ImageGridItem({ data: image }: ImageGridItemProps) {
  return (
    <Card shadow="sm" p={0} withBorder>
      <Card.Section>
        <ImageGuard
          images={[image]}
          render={(image) => (
            <Box sx={{ position: 'relative' }}>
              <Menu position="left">
                <Menu.Target>
                  <ActionIcon
                    variant="transparent"
                    p={0}
                    onClick={(e: React.MouseEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    sx={{
                      width: 30,
                      position: 'absolute',
                      top: 10,
                      right: 4,
                      zIndex: 8,
                    }}
                  >
                    <IconDotsVertical
                      size={24}
                      color="#fff"
                      style={{ filter: `drop-shadow(0 0 2px #000)` }}
                    />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <ReportImageButton imageId={image.id}>
                    <Menu.Item icon={<IconFlag size={14} stroke={1.5} />}>Report</Menu.Item>
                  </ReportImageButton>
                </Menu.Dropdown>
              </Menu>
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
                <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                  <MediaHash {...image} />
                </AspectRatio>
              </ImageGuard.Unsafe>
              <ImageGuard.Safe>
                <EdgeImage
                  src={image.url}
                  alt={image.name ?? undefined}
                  width={450}
                  placeholder="empty"
                  style={{ width: '100%', zIndex: 2, position: 'relative' }}
                />
              </ImageGuard.Safe>
            </Box>
          )}
        />
      </Card.Section>
      <Group position="apart" noWrap>
        <ActionIcon color="red">
          <IconTrash />
        </ActionIcon>
        <ActionIcon color="green">
          <IconCheck />
        </ActionIcon>
      </Group>
    </Card>
  );
}

type ImageGridItemProps = {
  data: ImageGetAllInfinite[number];
  index: number;
};
