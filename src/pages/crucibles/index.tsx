import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import Link from 'next/link';
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
import { useCurrentUser } from '~/hooks/useCurrentUser';

function CruciblesPage() {
  const filters = useCrucibleFilters();
  const currentUser = useCurrentUser();

  return (
    <>
      <Meta
        title="Civitai Crucibles | Head-to-Head Image Competitions"
        description="Compete in head-to-head image competitions, vote on entries, and win prizes in Buzz. Join active crucibles or create your own."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/crucibles`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        <Stack gap="md">
          {/* Page header with title and Create button */}
          <Group justify="space-between" align="center" wrap="wrap">
            <Title order={1}>Crucible Discovery</Title>
            {currentUser && (
              <Button
                component={Link}
                href="/crucibles/create"
                leftSection={<IconPlus size={18} />}
                radius="xl"
              >
                Create Crucible
              </Button>
            )}
          </Group>

          {/* User welcome section with stats */}
          <UserCrucibleWelcome />

          {/* Featured crucible hero card */}
          <FeaturedCrucibleHero />

          {/* Section header for discovery grid */}
          <Text fz="xl" fw={600} mt="md">
            Discover Crucibles
          </Text>

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
