import { Group, Stack } from '@mantine/core';

import { Announcements } from '~/components/Announcements/Announcements';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
import { SortFilter } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.bounties) return { notFound: true };
  },
});

export default function BountiesPage() {
  const currentUser = useCurrentUser();

  return (
    <>
      {/* TODO.bounty: update meta title and description accordingly */}
      <Meta
        title={`Civitai${
          !currentUser
            ? ` Bounties | Discover AI-Generated Images with Prompts and Resource Details`
            : ''
        }`}
        description="Browse Civitai Bounties, featuring AI-generated images along with prompts and resources used for their creation, showcasing the creativity of our talented community."
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.bounty}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [theme.fn.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              <FullHomeContentToggle />
              <Group spacing={8} noWrap>
                <SortFilter type="bounties" variant="button" />
                {/* <PeriodFilter type="bounties" /> */}
                <BountyFiltersDropdown />
              </Group>
            </Group>
            <BountiesInfinite />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
