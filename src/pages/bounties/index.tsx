import { SegmentedControl, Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
// import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import styles from './index.module.scss';

// export const getServerSideProps = createServerSideProps({
//   useSession: true,
//   resolver: async ({ features }) => {
//     if (!features?.bounties) return { notFound: true };
//   },
// });

function BountiesPage() {
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
        <Stack gap="xs">
          {query.engagement && (
            <Stack gap="xl" align="flex-start">
              <Title>My Bounties</Title>
              <SegmentedControl
                classNames={styles}
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

export default Page(BountiesPage, { InnerLayout: FeedLayout, announcements: true });
