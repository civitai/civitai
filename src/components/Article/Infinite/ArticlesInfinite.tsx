import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { ArticlesCard } from '~/components/Article/Infinite/ArticlesCard';
import {
  ArticleQueryParams,
  useArticleFilters,
  useQueryArticles,
} from '~/components/Article/article.utils';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { removeEmpty } from '~/utils/object-helpers';

const fakeArticles = Array.from({ length: 10 }, (_, i) => ({
  id: i,
  title: 'Lorem ipsum dolor sit amet consectetur adipisicing elit.',
  cover: `https://picsum.photos/450/450?random=${i}`,
  publishedAt: new Date(),
  tags: [
    { id: i + 1, name: 'Lorem', isCategory: true },
    { id: i + 2, name: 'ipsum', isCategory: false },
  ],
}));

export function ArticlesInfinite({ filters: filterOverrides = {}, showEof = false }: Props) {
  const { ref, inView } = useInView();
  const articlesFilters = useArticleFilters();
  const user = useCurrentUser();

  const filters = removeEmpty({ ...articlesFilters, ...filterOverrides });

  const { articles, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryArticles(filters, {
      keepPreviousData: true,
    });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && !isFetching) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView, isFetching]);
  // #endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!fakeArticles.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryColumns
            data={fakeArticles.map((article) => ({ ...article, user: user as any }))}
            imageDimensions={(data) => {
              // const width = data.image?.width ?? 450;
              // const height = data.image?.height ?? 450;
              return { width: 450, height: 450 };
            }}
            adjustHeight={({ imageRatio, height }) => height + (imageRatio >= 1 ? 60 : 0)}
            maxItemHeight={600}
            render={ArticlesCard}
            itemId={(data) => data.id}
          />
          {hasNextPage && !isLoading && !isRefetching && (
            <Center ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
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
    </>
  );
}

type Props = {
  filters?: Partial<Omit<ArticleQueryParams, 'view'>>;
  showEof?: boolean;
};
