import { Group, SegmentedControl, Stack, Title, createStyles } from '@mantine/core';
import { useRouter } from 'next/router';

import { Announcements } from '~/components/Announcements/Announcements';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
import { SortFilter } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { constants } from '~/server/common/constants';
import { BountyFiltersDropdown } from '~/components/Bounty/Infinite/BountyFiltersDropdown';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.bounties) return { notFound: true };
  },
});

const useStyles = createStyles((theme) => ({
  label: {
    padding: '6px 16px',
    textTransform: 'capitalize',
    backgroundColor:
      theme.colorScheme === 'dark'
        ? theme.fn.rgba(theme.colors.gray[3], 0.06)
        : theme.fn.rgba(theme.colors.gray[9], 0.06),
  },
  labelActive: {
    backgroundColor: 'transparent',
    '&,&:hover': {
      color: theme.colors.dark[9],
    },
  },
  active: {
    backgroundColor: theme.white,
  },
  root: {
    backgroundColor: 'transparent',
    gap: 8,

    [containerQuery.smallerThan('sm')]: {
      overflow: 'auto hidden',
      maxWidth: '100%',
    },
  },
  control: { border: 'none !important' },

  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function BountiesPage() {
  const { classes } = useStyles();
  const features = useFeatureFlags();
  const router = useRouter();
  const query = router.query;
  const engagement = constants.bounties.engagementTypes.find(
    (type) => type === ((query.engagement as string) ?? '').toLowerCase()
  );

  const handleEngagementChange = (value: string) => {
    router.push({ query: { engagement: value } }, '/bounties', { shallow: true });
  };

  return (
    <>
      <Meta
        title="Collaborate on Generative AI Art With Civitai Bounties"
        description="Post bounties and collaborate with generative AI creators, or make your mark in Civitai and earn Buzz by successfully completing them"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/bounties`, rel: 'canonical' }]}
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
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter type="bounties" variant="button" />
                <BountyFiltersDropdown />
              </Group>
            </Group>
            {query.engagement && (
              <Stack spacing="xl" align="flex-start">
                <Title>My Bounties</Title>
                <SegmentedControl
                  classNames={classes}
                  transitionDuration={0}
                  radius="xl"
                  mb="xl"
                  data={[...constants.bounties.engagementTypes]}
                  value={query.engagement as string}
                  onChange={handleEngagementChange}
                />
              </Stack>
            )}
            <BountiesInfinite filters={{ engagement }} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}

setPageOptions(BountiesPage, { innerLayout: FeedLayout });
