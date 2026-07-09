import { Center, Group, Loader, LoadingOverlay, SimpleGrid, Stack } from '@mantine/core';
import { useMemo } from 'react';
import { ModelCardContextProvider } from '~/components/Cards/ModelCardContext';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { useQueryEarlyAccessPrices } from '~/components/CreatorShop/creator-shop.util';
import { sectionIcons } from '~/components/CreatorShop/section-meta';
import { ModelShopCard } from '~/components/CreatorShop/Storefront/ModelShopCard';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { SortFilter } from '~/components/Filters';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { useModelQueryParams, useQueryModels } from '~/components/Model/model.utils';
import { NoContent } from '~/components/NoContent/NoContent';
import { ModelSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

export function ModelsSection({ shop, username }: { shop: CreatorShopData; username: string }) {
  const { set, ...queryFilters } = useModelQueryParams();
  const sort = queryFilters.sort ?? ModelSort.Newest;
  const period = queryFilters.period ?? MetricTimeframe.AllTime;

  // browsingLevel is applied inside useQueryModels; no need to pass it here.
  const { models, fetchNextPage, hasNextPage, isRefetching, isFetching } = useQueryModels({
    ...queryFilters,
    username,
    sort,
    period,
    earlyAccess: true,
    pending: true,
  });

  const versionIds = useMemo(() => models.map((m) => m.version.id), [models]);
  const priceByVersionId = useQueryEarlyAccessPrices(versionIds);

  if (!shop.settings.showModels || shop.earlyAccessModelCount <= 0) return null;

  return (
    <Stack gap="md">
      <SectionHeader
        icon={sectionIcons.models}
        title="Models"
        right={
          <Group gap="xs">
            <SortFilter
              type="models"
              value={sort}
              onChange={(x) => set({ sort: x as ModelSort })}
            />
            {/* Early Access is locked on for the shop, so hide its toggle. */}
            <ModelFiltersDropdown
              filterMode="query"
              position="left"
              size="compact-sm"
              hideEarlyAccess
            />
          </Group>
        }
      />

      <ModelCardContextProvider useModelVersionRedirect>
        {!models.length && isFetching ? (
          <Center p="xl">
            <Loader size="xl" />
          </Center>
        ) : models.length ? (
          <div className="relative">
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
            <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="md">
              {models.map((model) => (
                <ModelShopCard
                  key={model.id}
                  data={model}
                  price={priceByVersionId[model.version.id]}
                />
              ))}
            </SimpleGrid>
            {hasNextPage && (
              <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
                <Center p="xl" style={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </div>
        ) : (
          <NoContent py="lg" message="No Early Access models yet." />
        )}
      </ModelCardContextProvider>
    </Stack>
  );
}
