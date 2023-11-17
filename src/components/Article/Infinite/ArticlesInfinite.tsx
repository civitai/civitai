import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCloudOff } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';

import { ArticleCard } from '~/components/Article/Infinite/ArticleCard';
import { useArticleFilters, useQueryArticles } from '~/components/Article/article.utils';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { UniformGrid } from '~/components/MasonryColumns/UniformGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { InViewLoader } from '~/components/InView/InViewLoader';

export function ArticlesInfinite({ filters: filterOverrides = {}, showEof = false }: Props) {
  const articlesFilters = useArticleFilters();

  const filters = removeEmpty({ ...articlesFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { articles, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryArticles(
    debouncedFilters,
    { keepPreviousData: true }
  );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

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
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" sx={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
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
