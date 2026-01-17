import { SegmentedControl, Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { CruciblesInfinite } from '~/components/Crucible/CruciblesInfinite';
import { UserCrucibleWelcome } from '~/components/Crucible/UserCrucibleWelcome';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { useCrucibleFilters, useCrucibleQueryParams } from '~/components/Crucible/crucible.utils';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

function CruciblesPage() {
  const filters = useCrucibleFilters();
  const { replace } = useCrucibleQueryParams();

  const handleStatusChange = (value: string) => {
    if (value === 'All') {
      replace({ status: undefined });
    } else {
      replace({ status: value as CrucibleStatus });
    }
  };

  const statusData = [
    { label: 'All', value: 'All' },
    { label: 'Active', value: CrucibleStatus.Active },
    { label: 'Upcoming', value: CrucibleStatus.Pending },
    { label: 'Completed', value: CrucibleStatus.Completed },
  ];

  const currentStatusValue = filters.status || 'All';

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

          <SegmentedControl
            data={statusData}
            value={currentStatusValue}
            onChange={handleStatusChange}
            radius="xl"
            fullWidth={false}
          />

          <CruciblesInfinite filters={filters} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(CruciblesPage, { InnerLayout: FeedLayout, announcements: true });
