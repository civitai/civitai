import { SegmentedControl, Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { BountiesInfinite } from '~/components/Bounty/Infinite/BountiesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { constants } from '~/server/common/constants';
import styles from './index.module.css';
import type { BountyEngagementTypeQueryParam } from '~/components/Bounty/bounty.utils';
import { useBountyQueryParams } from '~/components/Bounty/bounty.utils';

function BountiesPage() {
  const { query, replace } = useBountyQueryParams();

  const handleEngagementChange = (value: string) => {
    replace({ engagement: value as BountyEngagementTypeQueryParam }, '/bounties');
  };

  return (
    <>
      <Meta
        title="Collaborate on Generative AI Art With Civitai Bounties"
        description="Post bounties and collaborate with generative AI creators, or make your mark in Civitai and earn Buzz by successfully completing them"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/bounties`, rel: 'canonical' }]}
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
                value={query.engagement}
                onChange={handleEngagementChange}
                withItemsBorders={false}
              />
            </Stack>
          )}
          <BountiesInfinite filters={query.engagement ? { ...query, status: undefined } : query} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(BountiesPage, { InnerLayout: FeedLayout, announcements: true });
