import { Group, Stack, ThemeIcon, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { ClubsInfinite } from '~/components/Club/Infinite/ClubsInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { FeatureIntroduction } from '../../components/FeatureIntroduction/FeatureIntroduction';
import classes from './index.module.css';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };
  },
});

export default function ClubsPage() {
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
          <Stack gap="xs">
            <Group justify="space-between" gap={8}>
              <Group className={classes.filtersWrapper} gap={8} wrap="nowrap">
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
                {/* <SortFilter type="clubs" /> */}
              </Group>
            </Group>
            {query.engagement && (
              <Stack gap="xl" align="flex-start">
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
