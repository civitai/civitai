import React from 'react';
import { FeedLayout } from '~/pages/clubs/[id]/index';
import { useRouter } from 'next/router';
import { Group, Stack } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ArticleSort, ModelSort } from '~/server/common/enums';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MetricTimeframe } from '@prisma/client';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';

const ClubArticles = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { query, replace } = useArticleQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ArticleSort.Newest;

  const filters = {
    ...query,
    sort,
    period: MetricTimeframe.AllTime,
    clubId: id,
  };

  return (
    <>
      <Stack mb="sm">
        <Group position="apart" spacing={0}>
          <SortFilter
            type="articles"
            value={sort}
            onChange={(x) => replace({ sort: x as ArticleSort })}
          />
          <Group spacing="xs">
            <PeriodFilter type="articles" value={period} onChange={(x) => replace({ period: x })} />
            <ArticleFiltersDropdown />
          </Group>
        </Group>
      </Stack>
      <MasonryProvider columnWidth={constants.cardSizes.articles} maxColumnCount={7}>
        <MasonryContainer fluid mt="md" p={0}>
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
