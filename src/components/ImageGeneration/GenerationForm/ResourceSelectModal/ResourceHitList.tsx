import { Center, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useInstantSearch } from 'react-instantsearch';
import cardClasses from '~/components/Cards/Cards.module.css';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { constants } from '~/server/common/constants';
import type { GetFeaturedModels } from '~/server/services/model.service';
import type { ResourceSelectOptions } from '../resource-select.types';
import { ResourceSelectCard } from './ResourceSelectCard';
import type { Tabs } from './useResourceSelectFilters';
import { isDefined } from '~/utils/type-guards';
import { NoContent } from '~/components/NoContent/NoContent';

export function ResourceHitList({
  likes,
  featured,
  selectedTab,
}: ResourceSelectOptions & {
  likes: number[] | undefined;
  featured: GetFeaturedModels | undefined;
  selectedTab?: Tabs;
}) {
  const { canGenerate, resources, selectSource, excludedIds } = useResourceSelectContext();
  const startedRef = useRef(false);
  const { status } = useInstantSearch();
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'models'>();
  const {
    items: models,
    loadingPreferences,
    hiddenCount,
  } = useApplyHiddenPreferences({
    type: 'models',
    data: items,
  });

  const loading =
    status === 'loading' || status === 'stalled' || loadingPreferences || !startedRef.current;

  // Use all featured models for position sorting — the Meilisearch query and
  // version filtering below handle which models actually appear
  const filteredFeaturedModels = featured;

  const filterVersions = useCallback(
    (model: SearchIndexDataMap['models'][number]) => {
      const modelBaseModels = resources
        .filter((x) => x.type === model.type)
        .flatMap((x) => x.baseModels);

      return model.versions.filter((version) => {
        return (
          (canGenerate ? canGenerate === version.canGenerate : true) &&
          (modelBaseModels.length > 0 ? modelBaseModels.includes(version.baseModel) : true) &&
          !excludedIds.includes(version.id)
        );
      });
    },
    [canGenerate, resources, excludedIds]
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
    if (selectedTab !== 'featured' || !filteredFeaturedModels?.length) return [];

    // Filter to featured entries matching current resource types and ecosystem.
    // For checkpoints, include all ecosystems so auction winners from any baseModel show.
    const isCheckpointOnly =
      resourceTypes.length > 0 && resourceTypes.every((t) => t === 'Checkpoint');
    const relevantFeatured = filteredFeaturedModels.filter(
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
  }, [selectedTab, filteredFeaturedModels, items, filterVersions, resourceTypes, resourceBaseModels]);

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
        const aPos = filteredFeaturedModels?.find((fm) => fm.modelId === a.id)?.position;
        const bPos = filteredFeaturedModels?.find((fm) => fm.modelId === b.id)?.position;
        if (!aPos) return 1;
        if (!bPos) return -1;
        return aPos - bPos;
      });
    }

    return ret;
  }, [canGenerate, filteredFeaturedModels, models, resources, selectedTab, filterVersions]);

  useEffect(() => {
    if (!startedRef.current && status !== 'idle') startedRef.current = true;
  }, [status]);

  const likesSet = useMemo(() => new Set(likes ?? []), [likes]);

  const renderCard = useCallback(
    ({ data, height }: { data: SearchIndexDataMap['models'][number]; height: number }) => (
      <ResourceSelectCard
        data={data}
        height={height}
        isFavorite={likesSet.has(data.id)}
        selectSource={selectSource}
      />
    ),
    [likesSet, selectSource]
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
  const restItems = selectedTab === 'featured'
    ? filtered.filter((m) => !topItemIds.has(m.id))
    : filtered;

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
            <ResourceSelectCard
              data={topItems[0]}
              isFavorite={likesSet.has(topItems[0].id)}
              selectSource={selectSource}
            />
          </div>
          {topItems.length > 1 && (
            <div className={cardClasses.winnerSecond}>
              <ResourceSelectCard
                data={topItems[1]}
                isFavorite={likesSet.has(topItems[1].id)}
                selectSource={selectSource}
              />
            </div>
          )}
          {topItems.length > 2 && (
            <div className={cardClasses.winnerThird}>
              <ResourceSelectCard
                data={topItems[2]}
                isFavorite={likesSet.has(topItems[2].id)}
                selectSource={selectSource}
              />
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

      {items.length > 0 && !isLastPage && (
        <InViewLoader loadFn={showMore} loadCondition={status === 'idle'}>
          <Center style={{ height: 36 }} my="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
  );
}
