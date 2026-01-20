import { Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client';
import type { PeriodMode } from '~/server/schema/base.schema';

function ModelsPage() {
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, query } = queryFilters;
  const periodMode = query ? ('stats' as PeriodMode) : undefined;

  if (periodMode) queryFilters.periodMode = periodMode;

  return (
    <>
      <Meta
        title="AI Models | Civitai"
        description="Browse thousands of free Stable Diffusion & Flux models, LoRAs, checkpoints, and embeddings. The largest collection of AI image generation resources."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/models`, rel: 'canonical' }]}
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
