import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { EarlyAccessHighlight } from '~/components/Model/EarlyAccessHighlight/EarlyAccessHighlight';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PeriodMode } from '~/server/schema/base.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';

export default function ModelsPage() {
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { setFilters, earlyAccess } = useFiltersContext((state) => ({
    setFilters: state.setModelFilters,
    earlyAccess: state.models.earlyAccess,
  }));
  const { username, query } = queryFilters;
  const periodMode = query ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;

  return (
    <>
      <Meta
        title="Civitai Models | Discover Free Stable Diffusion Models"
        description="Browse from thousands of free Stable Diffusion models, spanning unique anime art styles, immersive 3D renders, stunning photorealism, and more"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/models`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        {username && typeof username === 'string' && <Title>Models by {username}</Title>}
        <Stack spacing="xs">
          <Announcements
            sx={() => ({
              marginBottom: -35,
              [containerQuery.smallerThan('md')]: {
                marginBottom: -5,
              },
            })}
          />
          <IsClient>
            <EarlyAccessHighlight />
            <CategoryTags />
            <ModelsInfinite filters={queryFilters} showEof showAds />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </>
  );
}

setPageOptions(ModelsPage, { innerLayout: FeedLayout });
