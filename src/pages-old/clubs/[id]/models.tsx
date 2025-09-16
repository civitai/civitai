import React, { useState } from 'react';
import { FeedLayout } from '~/pages-old/clubs/[id]/index';
import { useRouter } from 'next/router';
import { Group, Stack } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ModelSort } from '~/server/common/enums';
import { DumbModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelQueryParams, useModelQueryParams } from '~/components/Model/model.utils';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { ModelFilterSchema } from '../../../providers/FiltersProvider';
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

const ClubModels = () => {
  const router = useRouter();
  const { id: stringId } = router.query as {
    id: string;
  };
  const id = Number(stringId);
  const [filters, setFilters] = useState<Partial<ModelFilterSchema> & { clubId: number }>({
    sort: ModelSort.Newest,
    period: MetricTimeframe.AllTime,
    clubId: id,
  });

  return (
    <>
      <Stack mb="sm">
        <Group justify="space-between" gap={0}>
          <SortFilter
            type="models"
            value={filters.sort as ModelSort}
            onChange={(x) => setFilters((f) => ({ ...f, sort: x as ModelSort }))}
          />
          <Group gap="xs">
            <DumbModelFiltersDropdown
              filters={filters}
              setFilters={(updated) => setFilters((f) => ({ ...f, ...updated }))}
            />
          </Group>
        </Group>
      </Stack>
      <MasonryProvider columnWidth={constants.cardSizes.model} maxColumnCount={7}>
        <MasonryContainer mt="md" p={0}>
          <ModelsInfinite
            disableStoreFilters
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
