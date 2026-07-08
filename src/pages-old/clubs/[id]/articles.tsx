import React, { useState } from 'react';
import { FeedLayout } from '~/pages-old/clubs/[id]/index';
import { useRouter } from 'next/router';
import { Group, Stack } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ArticleSort, ModelSort } from '~/server/common/enums';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import type { GetInfiniteArticlesSchema } from '~/server/schema/article.schema';
import { createServerSideProps } from '../../../server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: false,
    //   },
    // };
  },
});

const ClubArticles = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const [filters, setFilters] = useState<Partial<GetInfiniteArticlesSchema>>({
    sort: ArticleSort.Newest,
    period: MetricTimeframe.AllTime,
    clubId: id,
  });

  return (
    <>
      <Stack mb="sm">
        <Group justify="space-between" gap={0}>
          <SortFilter
            type="articles"
            value={filters.sort as ArticleSort}
            onChange={(x) => setFilters((f) => ({ ...f, sort: x as ArticleSort }))}
          />
          <Group gap="xs">
            <ArticleFiltersDropdown
              query={filters}
              // @ts-ignore: These are compatible.
              onChange={(updated) => setFilters((f) => ({ ...f, ...updated }))}
            />
          </Group>
        </Group>
      </Stack>
      <MasonryProvider columnWidth={constants.cardSizes.articles} maxColumnCount={7}>
        <MasonryContainer mt="md" p={0}>
          <ArticlesInfinite
            filters={{
              ...filters,
            }}
          />
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
};

ClubArticles.getLayout = function getLayout(page: React.ReactNode) {
  return <FeedLayout>{page}</FeedLayout>;
};

export default ClubArticles;
