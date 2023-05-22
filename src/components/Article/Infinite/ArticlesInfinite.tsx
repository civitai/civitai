import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { ArticleCard } from '~/components/Article/Infinite/ArticleCard';
import { useArticleFilters, useQueryArticles } from '~/components/Article/article.utils';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { UniformGrid } from '~/components/MasonryColumns/UniformGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { removeEmpty } from '~/utils/object-helpers';

export function ArticlesInfinite({ filters: filterOverrides = {}, showEof = false }: Props) {
  const { ref, inView } = useInView();
  const articlesFilters = useArticleFilters();

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
      ) : !!articles.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <UniformGrid
            data={articles}
            render={ArticleCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
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
  filters?: Partial<GetInfiniteArticlesSchema>;
  showEof?: boolean;
};
