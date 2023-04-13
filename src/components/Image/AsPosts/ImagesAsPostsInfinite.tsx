import {
  Button,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCloudOff, IconPlus, IconStar } from '@tabler/icons';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import { ImageCategories } from '~/components/Image/Infinite/ImageCategories';
import { parseImagesQuery } from '~/components/Image/image.utils';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useImageFilters } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

type ModelVersionsProps = { id: number; name: string };
type ImagesAsPostsInfiniteState = {
  modelId?: number;
  username?: string;
  modelVersions?: ModelVersionsProps[];
};
const ImagesAsPostsInfiniteContext = createContext<ImagesAsPostsInfiniteState | null>(null);
export const useImagesAsPostsInfiniteContext = () => {
  const context = useContext(ImagesAsPostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesAsPostsInfiniteProps = ImagesAsPostsInfiniteState & {
  selectedVersionId?: number;
  modelId: number;
};

const LIMIT = 50;
export default function ImagesAsPostsInfinite({
  modelId,
  username,
  modelVersions,
  selectedVersionId,
}: ImagesAsPostsInfiniteProps) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { ref, inView } = useInView();
  const isMobile = useIsMobile();
  const globalFilters = useImageFilters();
  const [limit] = useState(isMobile ? LIMIT / 2 : LIMIT);
  const filters = removeEmpty({
    ...globalFilters,
    ...parseImagesQuery(router.query),
    modelId,
    username,
    limit,
  });

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(filters, {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      // enabled: inView,
    });

  const items = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView]);
  // #endregion

  const isMuted = currentUser?.muted ?? false;
  const addPostLink = `/posts/create?modelId=${modelId}${
    selectedVersionId ? `&modelVersionId=${selectedVersionId}` : ''
  }&returnUrl=${router.asPath}`;

  return (
    <ImagesAsPostsInfiniteContext.Provider value={{ modelId, username, modelVersions }}>
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={6}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="md">
            <Group spacing="xs" align="flex-end">
              <Title order={2}>Gallery</Title>
              {!isMuted && (
                <Group>
                  <LoginRedirect reason="create-review">
                    <Button
                      component={NextLink}
                      variant="outline"
                      size="xs"
                      leftIcon={<IconPlus size={16} />}
                      href={addPostLink}
                    >
                      Add Post
                    </Button>
                  </LoginRedirect>
                  <LoginRedirect reason="create-review">
                    <Button
                      component={NextLink}
                      leftIcon={<IconStar size={16} />}
                      href={addPostLink + '&reviewing=true'}
                      variant="outline"
                      size="xs"
                    >
                      Add Review
                    </Button>
                  </LoginRedirect>
                </Group>
              )}
            </Group>
            {/* IMAGES */}
            <Group position="apart" spacing={0}>
              <SortFilter type="image" />
              <Group spacing={4}>
                <PeriodFilter />
                {/* <ImageFiltersDropdown /> */}
              </Group>
            </Group>
            <ImageCategories />
            {isLoading ? (
              <Paper style={{ minHeight: 200, position: 'relative' }}>
                <LoadingOverlay visible zIndex={10} />
              </Paper>
            ) : !!items.length ? (
              <div style={{ position: 'relative' }}>
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryColumns
                  data={items}
                  imageDimensions={(data) => {
                    const tallestImage = data.images.sort((a, b) => {
                      const aHeight = a.height ?? 0;
                      const bHeight = b.height ?? 0;
                      const aAspectRatio = aHeight > 0 ? (a.width ?? 0) / aHeight : 0;
                      const bAspectRatio = bHeight > 0 ? (b.width ?? 0) / bHeight : 0;
                      if (aAspectRatio < 1 && bAspectRatio >= 1) return -1;
                      if (bAspectRatio < 1 && aAspectRatio <= 1) return 1;
                      if (aHeight === bHeight) return 0;
                      return aHeight > bHeight ? -1 : 1;
                    })[0];

                    const width = tallestImage?.width ?? 450;
                    const height = tallestImage?.height ?? 450;
                    return { width, height };
                  }}
                  adjustHeight={({ height }, data) =>
                    height + 57 + (data.images.length > 1 ? 8 : 0)
                  }
                  maxItemHeight={600}
                  render={ImagesAsPostsCard}
                  itemId={(data) => data.images.map((x) => x.id).join('_')}
                />
                {hasNextPage && !isLoading && !isRefetching && (
                  <Center ref={ref} sx={{ height: 36 }} mt="md">
                    {inView && <Loader />}
                  </Center>
                )}
              </div>
            ) : (
              <Stack align="center" py="lg">
                <ThemeIcon size={128} radius={100}>
                  <IconCloudOff size={80} />
                </ThemeIcon>
                <Text size={32} align="center">
                  No results found
                </Text>
                <Text align="center">
                  {"Try adjusting your search or filters to find what you're looking for"}
                </Text>
              </Stack>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>

      {/* {isLoading && (
        <Paper style={{ minHeight: 200, position: 'relative' }}>
          <LoadingOverlay visible zIndex={10} />
        </Paper>
      )}
      {!isLoading && !items.length && (
        <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Stack>
            <Text size="xl">There are no images for this model yet.</Text>
            <Text color="dimmed">
              Add a post to showcase your images generated from this model.
            </Text>
          </Stack>
        </Paper>
      )} */}
    </ImagesAsPostsInfiniteContext.Provider>
  );
}
