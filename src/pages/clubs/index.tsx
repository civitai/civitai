import { createStyles, Group, Stack, ThemeIcon, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { Announcements } from '~/components/Announcements/Announcements';
import { ClubsInfinite } from '~/components/Club/Infinite/ClubsInfinite';
import { SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { FeatureIntroduction } from '../../components/FeatureIntroduction/FeatureIntroduction';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    console.log('features', features);
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };
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

    [theme.fn.smallerThan('sm')]: {
      overflow: 'auto hidden',
      maxWidth: '100%',
    },
  },
  control: { border: 'none !important' },

  filtersWrapper: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function ClubsPage() {
  const { classes } = useStyles();
  const router = useRouter();
  const query = router.query;

  const engagement = constants.clubs.engagementTypes.find(
    (type) => type === ((query.engagement as string) ?? '').toLowerCase()
  );

  // const handleEngagementChange = (value: string) => {
  //   router.push({ query: { engagement: value } }, '/clubs', { shallow: true });
  // };

  return (
    <>
      <Meta
        title="Join & Support creators on Civitai Clubs"
        description="Create, join and share your own Civitai Clubs."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/bounties`, rel: 'canonical' }]}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.club}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer>
          <Announcements />
          <Stack spacing="xs">
            <Group position="apart" spacing={8}>
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                {!query.engagement && (
                  <FeatureIntroduction
                    feature="clubs"
                    contentSlug={['feature-introduction', 'clubs']}
                    actionButton={
                      <ThemeIcon variant="light" radius="xl" size="lg">
                        <IconInfoCircle />
                      </ThemeIcon>
                    }
                  />
                )}
                <SortFilter type="clubs" variant="button" />
              </Group>
            </Group>
            {query.engagement && (
              <Stack spacing="xl" align="flex-start">
                <Title>My Clubs</Title>
                {/* <SegmentedControl
                  classNames={classes}
                  transitionDuration={0}
                  radius="xl"
                  mb="xl"
                  data={[...constants.clubs.engagementTypes]}
                  value={query.engagement as string}
                  onChange={handleEngagementChange}
                /> */}
              </Stack>
            )}
            <ClubsInfinite filters={{ engagement }} showEof={!engagement} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
