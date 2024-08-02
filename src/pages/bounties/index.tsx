import { createStyles, SegmentedControl, Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
// import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { env } from '~/env/client.mjs';
import { constants } from '~/server/common/constants';
import { containerQuery } from '~/utils/mantine-css-helpers';

// export const getServerSideProps = createServerSideProps({
//   useSession: true,
//   resolver: async ({ features }) => {
//     if (!features?.bounties) return { notFound: true };
//   },
// });

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
    marginLeft: -4,

    [containerQuery.smallerThan('sm')]: {
      overflow: 'auto hidden',
      maxWidth: '100%',
    },
  },
  control: { border: 'none !important' },
}));

export default function BountiesPage() {
  const { classes } = useStyles();
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

      <MasonryContainer>
        <Announcements />
        <Stack spacing="xs">
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
    </>
  );
}

setPageOptions(BountiesPage, { innerLayout: FeedLayout });
