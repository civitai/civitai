import { Center, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useMemo } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import type { TransformedModel } from '~/shared/search/models-transform';
import { trpc } from '~/utils/trpc';
import { ResourceSelectCard } from './ResourceSelectCard';
import { skipBaseModelForOwnTabs, type Tabs } from './useResourceSelectFilters';
import { useResourceSelectInfinite } from './useResourceSelectInfinite';
import { isDefined } from '~/utils/type-guards';

export function ResourceHitList({ selectedTab, query }: { selectedTab: Tabs; query: string }) {
  const { canGenerate, resources, selectSource, excludedIds, sort } = useResourceSelectContext();

  const { data: featured } = trpc.model.getFeaturedModels.useQuery(undefined, {
    enabled: selectedTab === 'featured',
  });

  const { items, isLoading, isFetching, isFetchingNextPage, fetchNextPage, hasNextPage } =
    useResourceSelectInfinite({ selectedTab, query, sort });

  const {
    items: models,
    loadingPreferences,
    hiddenCount,
  } = useApplyHiddenPreferences({
    type: 'models',
    data: items,
  });

  const loading = isLoading || isFetching || loadingPreferences;

  const filterVersions = useCallback(
    (model: TransformedModel) => {
      // Mirror the server query's base-model relaxation so we don't strip every
      // version client-side (e.g. linking a Flux VAE into a Boogu checkpoint).
      // The featured tab is a cross-ecosystem podium (the server returns winners
      // from any baseModel), so don't re-apply the ecosystem's base-model filter.
      const skipBaseModel =
        skipBaseModelForOwnTabs(selectedTab, selectSource) || selectedTab === 'featured';
      const modelBaseModels = resources
        .filter((x) => x.type === model.type)
        .flatMap((x) => x.baseModels);

      return model.versions.filter((version) => {
        return (
          (canGenerate ? canGenerate === version.canGenerate : true) &&
          (skipBaseModel ||
            modelBaseModels.length === 0 ||
            modelBaseModels.includes(version.baseModel)) &&
          !excludedIds.includes(version.id)
        );
      });
    },
    [canGenerate, resources, excludedIds, selectedTab, selectSource]
  );

  // Build podium items from raw items (bypassing hidden preferences) so
  // auction winners at positions 1-3 always show regardless of user preferences.
  // Filter by resource types AND baseModels to match the current ecosystem's auction.
  const resourceTypes = useMemo(() => resources.map((r) => r.type), [resources]);
  const resourceBaseModels = useMemo(
    () => new Set(resources.flatMap((r) => r.baseModels)),
    [resources]
  );
  const topItems = useMemo(() => {
    if (selectedTab !== 'featured' || !featured?.length) return [];

    // For checkpoints, include all ecosystems so auction winners from any baseModel show.
    const isCheckpointOnly =
      resourceTypes.length > 0 && resourceTypes.every((t) => t === 'Checkpoint');
    const relevantFeatured = featured.filter(
      (fm) =>
        resourceTypes.includes(fm.type) &&
        (isCheckpointOnly || resourceBaseModels.size === 0 || resourceBaseModels.has(fm.baseModel))
    );
    const podiumEntries = relevantFeatured.filter((fm) => fm.position >= 1 && fm.position <= 3);
    const podiumIds = new Set(podiumEntries.map((fm) => fm.modelId));

    return items
      .filter((model) => podiumIds.has(model.id))
      .map((model) => {
        const versions = filterVersions(model);
        if (!versions.length) return null;
        return { ...model, versions };
      })
      .filter(isDefined)
      .sort((a, b) => {
        const aPos = relevantFeatured.find((fm) => fm.modelId === a.id)!.position;
        const bPos = relevantFeatured.find((fm) => fm.modelId === b.id)!.position;
        return aPos - bPos;
      });
  }, [selectedTab, featured, items, filterVersions, resourceTypes, resourceBaseModels]);

  const topItemIds = useMemo(() => new Set(topItems.map((m) => m.id)), [topItems]);

  const filtered = useMemo(() => {
    if (!canGenerate && !resources.length) return models;

    const ret = models
      .map((model) => {
        const versions = filterVersions(model);
        if (!versions.length) return null;
        return { ...model, versions };
      })
      .filter(isDefined)
      .filter((model) => model.versions.length > 0);

    if (selectedTab === 'featured') {
      ret.sort((a, b) => {
        const aPos = featured?.find((fm) => fm.modelId === a.id)?.position;
        const bPos = featured?.find((fm) => fm.modelId === b.id)?.position;
        if (!aPos) return 1;
        if (!bPos) return -1;
        return aPos - bPos;
      });
    }

    return ret;
  }, [canGenerate, featured, models, resources, selectedTab, filterVersions]);

  const renderCard = useCallback(
    ({ data, height }: { data: TransformedModel; height: number }) => (
      <ResourceSelectCard data={data} height={height} selectSource={selectSource} />
    ),
    [selectSource]
  );

  if (loading && !filtered.length)
    return (
      <div className="p-3 py-5">
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );

  if (!filtered.length)
    return (
      <div className="my-20 p-3 py-5">
        <Center>
          <Stack gap="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text c="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
            )}
            <ThemeIcon size={128} radius={100} style={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} className="inline">
              No models found
            </Title>
            <Text align="center">
              We have a bunch of models, but it looks like we couldn&rsquo;t find any matching your
              query.
            </Text>
          </Stack>
        </Center>
      </div>
    );

  // Exclude podium items from the main grid
  const restItems =
    selectedTab === 'featured' ? filtered.filter((m) => !topItemIds.has(m.id)) : filtered;

  return (
    <div className="flex flex-col gap-3 p-3">
      {hiddenCount > 0 && (
        <Text c="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
      )}

      {topItems.length > 0 && (
        <div
          className={clsx(
            '!grid grid-cols-[repeat(auto-fit,350px)] justify-center justify-items-center gap-6 p-3'
          )}
        >
          <div className={cardClasses.winnerFirst}>
            <ResourceSelectCard data={topItems[0]} selectSource={selectSource} />
          </div>
          {topItems.length > 1 && (
            <div className={cardClasses.winnerSecond}>
              <ResourceSelectCard data={topItems[1]} selectSource={selectSource} />
            </div>
          )}
          {topItems.length > 2 && (
            <div className={cardClasses.winnerThird}>
              <ResourceSelectCard data={topItems[2]} selectSource={selectSource} />
            </div>
          )}
        </div>
      )}

      <MasonryProvider columnWidth={278} maxColumnCount={4}>
        <MasonryColumnsVirtual
          data={restItems}
          render={renderCard}
          imageDimensions={() => ({ width: 450, height: Math.round(450 * (9 / 7)) })}
          adjustHeight={({ height }) => height + 82}
          itemId={(x) => x.id}
        />
      </MasonryProvider>

      {items.length > 0 && hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetchingNextPage}>
          <Center style={{ height: 36 }} my="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
  );
}
