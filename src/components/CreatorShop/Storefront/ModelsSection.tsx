import { Group, Stack, Text, Title } from '@mantine/core';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { SectionAccent } from '~/components/CreatorShop/Storefront/SectionAccent';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

export function ModelsSection({
  shop,
  displayName,
  username,
}: {
  shop: CreatorShopData;
  displayName: string;
  username: string;
}) {
  const { set, ...queryFilters } = useModelQueryParams();
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const period = queryFilters.period ?? MetricTimeframe.AllTime;

  if (!shop.settings.showModels || shop.earlyAccessModelCount <= 0) return null;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Group gap={10} align="center">
            <SectionAccent />
            <Title order={4}>Models</Title>
          </Group>
          <Text size="xs" c="dimmed">
            Early Access models by {displayName}
          </Text>
        </div>
        <Group gap="xs">
          <SortFilter type="models" value={sort} onChange={(x) => set({ sort: x as ModelSort })} />
          {/* Early Access is locked on for the shop, so hide its toggle. */}
          <ModelFiltersDropdown
            filterMode="query"
            position="left"
            size="compact-sm"
            hideEarlyAccess
          />
        </Group>
      </Group>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          {/* The creator's models, filterable — but locked to Early Access (paid tiers come later). */}
          <ModelsInfinite
            filters={{ ...queryFilters, username, sort, period, earlyAccess: true, pending: true }}
            disableStoreFilters
          />
        </MasonryContainer>
      </MasonryProvider>
    </Stack>
  );
}
