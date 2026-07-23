import { useState } from 'react';
import { Stack, Title, Group, Button, SegmentedControl } from '@mantine/core';
import { IconTrophy, IconUsers, IconArrowLeft } from '@tabler/icons-react';
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
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
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
type Engagement = 'participated' | 'created';

const engagementStatuses: Record<Engagement, MyChallengeStatus[]> = {
  // You can't enter a challenge that hasn't started, and a cancelled one you entered is a refund,
  // not a thing to browse — so Participated gets a narrower set than Created.
  participated: ['Active', 'Completed'],
  created: ['Scheduled', 'Active', 'Completed', 'Cancelled'],
};

const myStatusFilters: Record<MyChallengeStatus, Partial<GetInfiniteChallengesInput>> = {
  Scheduled: { status: [ChallengeStatus.Scheduled], includeEnded: false },
  Active: { status: [ChallengeStatus.Active], includeEnded: false },
  Completed: {
    status: [ChallengeStatus.Completing, ChallengeStatus.Completed],
    includeEnded: true,
  },
  Cancelled: { status: [ChallengeStatus.Cancelled], includeEnded: true },
};

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

  const rawEngagement = router.query.engagement;
  const isPersonalView = rawEngagement === 'created' || rawEngagement === 'participated';
  const engagement: Engagement = rawEngagement === 'created' ? 'created' : 'participated';
  // Creators arrive from the header menu to check on what they've queued up, so Created opens on
  // Scheduled; entrants care about what's running.
  const [statusSelection, setStatusSelection] = useState<MyChallengeStatus>(
    rawEngagement === 'created' ? 'Scheduled' : 'Active'
  );
  // /challenges and /challenges?engagement=* are the same page with no route key, so switching
  // engagement via a link (header menu, the in-page control) doesn't remount — reset the status
  // explicitly rather than relying on the initializer above, which only runs once per mount.
  // Render-phase adjustment (not an effect) so the stale status is never committed/painted, and
  // ChallengesInfinite never mounts with it — see https://react.dev/learn/you-might-not-need-an-effect.
  const [prevEngagement, setPrevEngagement] = useState(rawEngagement);
  if (prevEngagement !== rawEngagement) {
    setPrevEngagement(rawEngagement);
    setStatusSelection(rawEngagement === 'created' ? 'Scheduled' : 'Active');
  }
  const allowedStatuses = engagementStatuses[engagement];
  const myStatus = allowedStatuses.includes(statusSelection)
    ? statusSelection
    : allowedStatuses[0];

  const handleEngagementChange = (next: string) => {
    router.replace(
      { pathname: '/challenges', query: { ...router.query, engagement: next } },
      undefined,
      { shallow: true }
    );
  };

  if (isPersonalView) {
    if (!currentUser) return <NotFound />;
    if (engagement === 'created' && !features.userChallenges) return <NotFound />;

    const engagementOptions = [
      { label: 'Participated', value: 'participated' },
      ...(features.userChallenges ? [{ label: 'Created', value: 'created' }] : []),
    ];

    const personalFilters: Partial<GetInfiniteChallengesInput> =
      engagement === 'created'
        ? { userId: currentUser.id, source: [ChallengeSource.User], excludeEventChallenges: true }
        : { participation: ChallengeParticipation.Entered };

    return (
      <MasonryContainer>
        <Stack gap="xs">
          <Stack gap="xl" align="flex-start" w="100%">
            <Group justify="space-between" w="100%" wrap="nowrap" gap="sm">
              <Group gap="sm" wrap="nowrap">
                <LegacyActionIcon
                  component={Link}
                  href="/challenges"
                  aria-label="Back to challenges"
                >
                  <IconArrowLeft size={20} />
                </LegacyActionIcon>
                <Title>Your Challenges</Title>
              </Group>
              {createChallengeButton}
            </Group>
            <Group justify="space-between" w="100%" wrap="wrap" gap="sm">
              {engagementOptions.length > 1 && (
                <SegmentedControl
                  classNames={styles}
                  transitionDuration={0}
                  radius="xl"
                  data={engagementOptions}
                  value={engagement}
                  onChange={handleEngagementChange}
                  withItemsBorders={false}
                />
              )}
              <SegmentedControl
                classNames={styles}
                transitionDuration={0}
                radius="xl"
                data={allowedStatuses}
                value={myStatus}
                onChange={(v) => setStatusSelection(v as MyChallengeStatus)}
                withItemsBorders={false}
              />
            </Group>
          </Stack>
          <ChallengesInfinite
            filters={{ ...personalFilters, ...myStatusFilters[myStatus] }}
            emptyAction={engagement === 'created' ? createChallengeButton : undefined}
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
                  {createChallengeButton}
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
