import { Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import {
  useModelBrowseFilters,
  useModelBrowseUrlSync,
  useModelQueryParams,
} from '~/components/Model/model.utils';
import type { PeriodMode } from '~/server/schema/base.schema';

function ModelsPage() {
  const { set, view: queryView, ...queryParams } = useModelQueryParams();
  const { feedOverrides } = useModelBrowseFilters();
  const { username, query } = queryParams;
  const periodMode = query ? ('stats' as PeriodMode) : undefined;
  const queryFilters = { ...queryParams, ...feedOverrides };

  if (periodMode) queryFilters.periodMode = periodMode;

  useModelBrowseUrlSync();

  return (
    <>
      <Meta
        title="AI Image & Video Models, LoRAs & Checkpoints | Civitai"
        description="Download AI image and video models from the largest community library: checkpoints and LoRAs for Illustrious, Pony, SDXL, Flux, Wan and more."
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
