import { Title } from '@mantine/core';
import { useEffect } from 'react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useFiltersContext, type ModelFilterSchema } from '~/providers/FiltersProvider';
import type { PeriodMode } from '~/server/schema/base.schema';

// Filter fields that a deep-link (e.g. the ecosystem "Browse models" CTA) may seed via the
// URL. On arrival we copy them into the persistent filter store — so the dropdown reflects
// them and its Clear button removes them — then strip them from the URL. Plain /models visits
// (no filter params) are untouched: normal localStorage-backed filtering, persisted per session.
const SEEDABLE_FILTER_KEYS = [
  'baseModels',
  'types',
  'checkpointType',
  'status',
  'fileFormats',
  'availability',
  'supportsGeneration',
  'earlyAccess',
  'fromPlatform',
  'isFeatured',
] as const;

function useSeedFiltersFromQuery(
  queryFilters: Partial<ModelFilterSchema>,
  clearQuery: (filters: Partial<Record<(typeof SEEDABLE_FILTER_KEYS)[number], undefined>>) => void
) {
  const setModelFilters = useFiltersContext((state) => state.setModelFilters);

  useEffect(() => {
    const incoming: Partial<ModelFilterSchema> = {};
    for (const key of SEEDABLE_FILTER_KEYS) {
      const value = queryFilters[key];
      if (value !== undefined) (incoming as Record<string, unknown>)[key] = value;
    }
    const seededKeys = Object.keys(incoming) as (typeof SEEDABLE_FILTER_KEYS)[number][];
    if (seededKeys.length === 0) return;

    setModelFilters(incoming);
    // Strip only the seeded keys — leaves query/username/tag/etc. intact. Stripping updates the
    // URL, which re-runs this effect with no seedable keys left, so it self-terminates.
    clearQuery(Object.fromEntries(seededKeys.map((key) => [key, undefined])));
  }, [queryFilters, setModelFilters, clearQuery]);
}

function ModelsPage() {
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, query } = queryFilters;
  const periodMode = query ? ('stats' as PeriodMode) : undefined;

  if (periodMode) queryFilters.periodMode = periodMode;

  useSeedFiltersFromQuery(queryFilters, set);

  return (
    <>
      <Meta
        title="AI Models | Civitai"
        description="Browse thousands of free Stable Diffusion & Flux models, LoRAs, checkpoints, and embeddings. The largest collection of AI image generation resources."
        canonical="/models"
      />

      <MasonryContainer className="flex flex-col gap-2">
        {username && typeof username === 'string' && <Title>Models by {username}</Title>}
        <div className="flex flex-col gap-2">
          <CategoryTags />
          <ModelsInfinite filters={queryFilters} showEof showAds />
        </div>
      </MasonryContainer>
    </>
  );
}

export default Page(ModelsPage, { InnerLayout: FeedLayout, announcements: true });
