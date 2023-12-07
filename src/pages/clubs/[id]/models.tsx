import React, { useMemo } from 'react';
import { FeedLayout } from '~/pages/clubs/[id]/index';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { useQueryClubPosts } from '~/components/Club/club.utils';
import { ClubPostItem, useClubFeedStyles } from '~/components/Club/ClubPost/ClubFeed';
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
import { ClubPostUpsertForm } from '~/components/Club/ClubPost/ClubPostUpsertForm';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ModelSort } from '~/server/common/enums';
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

const ClubModels = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const { set, ...query } = useModelQueryParams();
  const period = query.period ?? MetricTimeframe.AllTime;
  const sort = query.sort ?? ModelSort.Newest;

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
          <SortFilter type="models" value={sort} onChange={(x) => set({ sort: x as ModelSort })} />
          <Group spacing="xs">
            <PeriodFilter type="models" value={period} onChange={(x) => set({ period: x })} />
            <ModelFiltersDropdown />
          </Group>
        </Group>
        <CategoryTags />
      </Stack>
      <MasonryProvider columnWidth={constants.cardSizes.model} maxColumnCount={7}>
        <MasonryContainer fluid mt="md" p={0}>
          <ModelsInfinite
            filters={{
              ...filters,
            }}
          />
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
};

ClubModels.getLayout = function getLayout(page: React.ReactNode) {
  return <FeedLayout>{page}</FeedLayout>;
};

export default ClubModels;
