import { useState } from 'react';
import { Stack, Title, Group, Button, SegmentedControl } from '@mantine/core';
import { IconTrophy, IconUsers } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { DailyChallengesSection } from '~/components/Challenge/DailyChallengesSection';
import { FeaturedChallengeEvents } from '~/components/Challenge/FeaturedChallengeEvents';
import { SectionBand } from '~/components/Challenge/SectionBand';
import { YourChallengesRow } from '~/components/Challenge/YourChallengesRow';
import { ChallengeFeedFilters } from '~/components/Filters/FeedFilters/ChallengeFeedFilters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import {
  parseStatusQuery,
  parseParticipationQuery,
} from '~/components/Challenge/Infinite/ChallengeFiltersDropdown';
import { ChallengeSort, ChallengeParticipation } from '~/server/schema/challenge.schema';
import type { GetInfiniteChallengesInput } from '~/server/schema/challenge.schema';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import styles from './index.module.css';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.challengePlatform) return { notFound: true };
    return { props: {} };
  },
});

const statusMap: Record<string, ChallengeStatus> = {
  active: ChallengeStatus.Active,
  upcoming: ChallengeStatus.Scheduled,
  completed: ChallengeStatus.Completed,
};

type MyChallengeStatus = 'Scheduled' | 'Active' | 'Completed' | 'Cancelled';

function ChallengesPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const canCreateChallenge =
    !currentUser?.muted &&
    features.canWrite &&
    features.challengePlatform &&
    features.userChallenges;
  const createChallengeButton = canCreateChallenge ? (
    <Button
      component={Link}
      href="/challenges/create"
      leftSection={<IconTrophy size={16} />}
      variant="light"
      rel="nofollow"
    >
      Create Challenge
    </Button>
  ) : null;

  // Parse query params
  const sort = (router.query.sort as ChallengeSort) || ChallengeSort.Newest;
  const statusFilters = parseStatusQuery(router.query.status);
  const statusArray = statusFilters
    .map((s) => statusMap[s])
    .filter((s): s is ChallengeStatus => s != null);
  const includeEnded = statusFilters.includes('completed');
  const participation = parseParticipationQuery(router.query.participation);

  const mine = router.query.engagement === 'created';
  const [myStatus, setMyStatus] = useState<MyChallengeStatus>('Scheduled');

  const myStatusFilters: Record<MyChallengeStatus, Partial<GetInfiniteChallengesInput>> = {
    Scheduled: { status: [ChallengeStatus.Scheduled], includeEnded: false },
    Active: { status: [ChallengeStatus.Active], includeEnded: false },
    Completed: { status: [ChallengeStatus.Completed], includeEnded: true },
    Cancelled: { status: [ChallengeStatus.Cancelled], includeEnded: true },
  };

  const participated = router.query.engagement === 'participated';
  const [participatedStatus, setParticipatedStatus] = useState<'Active' | 'Completed'>('Active');
  const participatedStatusFilters: Record<string, Partial<GetInfiniteChallengesInput>> = {
    Active: { status: [ChallengeStatus.Active], includeEnded: false },
    Completed: {
      status: [ChallengeStatus.Completing, ChallengeStatus.Completed],
      includeEnded: true,
    },
  };

  if (mine) {
    if (!currentUser || !features.userChallenges) return <NotFound />;
    return (
      <MasonryContainer>
        <Stack gap="xs">
          <Stack gap="xl" align="flex-start">
            <Group justify="space-between" w="100%" wrap="nowrap" gap="sm">
              <Title>My Challenges</Title>
              {createChallengeButton}
            </Group>
            <SegmentedControl
              classNames={styles}
              transitionDuration={0}
              radius="xl"
              data={['Scheduled', 'Active', 'Completed', 'Cancelled']}
              value={myStatus}
              onChange={(v) => setMyStatus(v as MyChallengeStatus)}
              withItemsBorders={false}
            />
          </Stack>
          <ChallengesInfinite
            filters={{
              userId: currentUser.id,
              source: [ChallengeSource.User],
              excludeEventChallenges: true,
              ...myStatusFilters[myStatus],
            }}
            emptyAction={createChallengeButton}
          />
        </Stack>
      </MasonryContainer>
    );
  }

  if (participated) {
    if (!currentUser) return <NotFound />;
    return (
      <MasonryContainer>
        <Stack gap="xs">
          <Stack gap="xl" align="flex-start">
            <Title>Challenges You&apos;ve Entered</Title>
            <SegmentedControl
              classNames={styles}
              transitionDuration={0}
              radius="xl"
              data={['Active', 'Completed']}
              value={participatedStatus}
              onChange={(v) => setParticipatedStatus(v as 'Active' | 'Completed')}
              withItemsBorders={false}
            />
          </Stack>
          <ChallengesInfinite
            filters={{
              participation: ChallengeParticipation.Entered,
              ...participatedStatusFilters[participatedStatus],
            }}
          />
        </Stack>
      </MasonryContainer>
    );
  }

  return (
    <>
      <Meta
        title="AI Art Challenges | Civitai"
        description="Participate in AI art challenges, compete for prizes, and showcase your creative skills with the Civitai community"
        canonical="/challenges"
      />

      <div className={styles.sections}>
        <FeaturedChallengeEvents />

        <YourChallengesRow />

        <DailyChallengesSection />

        {/* Behind the userChallenges flag: with it off, the page shows only the daily-challenge experience. */}
        {features.userChallenges && (
          <SectionBand>
            <Stack gap="md">
              <Group wrap="wrap" gap="sm">
                <Group gap="xs" wrap="nowrap" align="center">
                  <IconUsers size={20} color="var(--mantine-color-cyan-7)" />
                  <Title order={3}>Community Challenges</Title>
                </Group>
                <Group gap="sm" wrap="wrap" ml="auto">
                  <ChallengeFeedFilters />
                </Group>
              </Group>
              <ChallengesInfinite
                filters={{
                  source: [ChallengeSource.User, ChallengeSource.Mod],
                  sort,
                  status: statusArray.length > 0 ? statusArray : undefined,
                  includeEnded,
                  excludeEventChallenges: true,
                  participation,
                }}
              />
            </Stack>
          </SectionBand>
        )}
      </div>
    </>
  );
}

export default Page(ChallengesPage, { InnerLayout: FeedLayout, announcements: true });
