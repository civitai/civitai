import { Button, Group, Stack, Title } from '@mantine/core';
import { IconClock } from '@tabler/icons-react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PeriodMode } from '~/server/schema/base.schema';

function ModelsPage() {
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, query } = queryFilters;
  const periodMode = query ? ('stats' as PeriodMode) : undefined;
  const { setFilters, earlyAccess } = useFiltersContext((state) => ({
    setFilters: state.setModelFilters,
    earlyAccess: state.models.earlyAccess,
  }));
  if (periodMode) queryFilters.periodMode = periodMode;

  return (
    <>
      <Meta
        title="Civitai Models | Discover Free Stable Diffusion & Flux Models"
        description="Browse from thousands of free Stable Diffusion & Flux models, spanning unique anime art styles, immersive 3D renders, stunning photorealism, and more"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/models`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        {username && typeof username === 'string' && <Title>Models by {username}</Title>}
        <Stack spacing="xs">
          <IsClient>
            {/* TODO: Bring back something similar in the future once we start selling spots. */}
            {/* <EarlyAccessHighlight /> */}
            <Group spacing="xs" noWrap>
              <Button
                variant={earlyAccess ? 'filled' : 'outline'}
                color="success.5"
                onClick={() => setFilters({ earlyAccess: !earlyAccess })}
                compact
                leftIcon={<IconClock size={16} />}
              >
                Early Access
              </Button>
              <CategoryTags />
            </Group>
            <ModelsInfinite filters={queryFilters} showEof showAds />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ModelsPage, { InnerLayout: FeedLayout, announcements: true });
