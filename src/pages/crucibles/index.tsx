import { Group, Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CruciblesInfinite } from '~/components/Crucible/CruciblesInfinite';
import { UserCrucibleWelcome } from '~/components/Crucible/UserCrucibleWelcome';
import { FeaturedCrucibleHero } from '~/components/Crucible/FeaturedCrucibleHero';
import { CrucibleSortDropdown } from '~/components/Crucible/CrucibleSortDropdown';
import { CrucibleFilterTabs } from '~/components/Crucible/CrucibleFilterTabs';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { useCrucibleFilters } from '~/components/Crucible/crucible.utils';

function CruciblesPage() {
  const filters = useCrucibleFilters();

  return (
    <>
      <Meta
        title="Civitai Crucibles | Head-to-Head Image Competitions"
        description="Compete in head-to-head image competitions, vote on entries, and win prizes in Buzz. Join active crucibles or create your own."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/crucibles`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        <Stack gap="md">
          <Title order={1}>Crucibles</Title>

          {/* User welcome section with stats */}
          <UserCrucibleWelcome />

          {/* Featured crucible hero card */}
          <FeaturedCrucibleHero />

          {/* Filter controls with underline tabs and sort dropdown */}
          <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
            <CrucibleFilterTabs />
            <CrucibleSortDropdown />
          </Group>

          <CruciblesInfinite filters={filters} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(CruciblesPage, { InnerLayout: FeedLayout, announcements: true });
