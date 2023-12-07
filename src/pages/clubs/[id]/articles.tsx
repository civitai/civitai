import React, { useMemo } from 'react';
import { FeedLayout } from '~/pages/clubs/[id]/index';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { useQueryClubPosts } from '~/components/Club/club.utils';
import { ClubPostItem, useClubFeedStyles } from '~/components/Club/ClubFeed';
import {
  Center,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { IconClubs } from '@tabler/icons-react';
import { ClubPostUpsertForm } from '~/components/Club/ClubPostUpsertForm';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ArticleSort, ModelSort } from '~/server/common/enums';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { UserDraftModels } from '~/components/User/UserDraftModels';
import UserTrainingModels from '~/components/User/UserTrainingModels';
import { NotFound } from '~/components/AppLayout/NotFound';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { CollectionMode, MetricTimeframe } from '@prisma/client';
import { getRandom } from '~/utils/array-helpers';
import { ArticlesInfinite } from '~/components/Article/Infinite/ArticlesInfinite';
import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';

const ClubArticles = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { query } = useArticleQueryParams();
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
            onChange={(x) => set({ sort: x as ArticleSort })}
          />
          <Group spacing="xs">
            <PeriodFilter type="articles" value={period} onChange={(x) => set({ period: x })} />
            <ArticleFiltersDropdown />
          </Group>
        </Group>
        <CategoryTags />
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
