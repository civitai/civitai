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
        title="Civitai Models | Discover Free Stable Diffusion & Flux Models"
        description="Browse from thousands of free Stable Diffusion & Flux models, spanning unique anime art styles, immersive 3D renders, stunning photorealism, and more"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/models`, rel: 'canonical' }]}
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
