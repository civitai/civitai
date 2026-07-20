import { useState } from 'react';
import {
  Stack,
  Title,
  Group,
  Text,
  Button,
  ActionIcon,
  Modal,
  Divider,
  SegmentedControl,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconSettings, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { DailyChallengesRow } from '~/components/Challenge/DailyChallengesRow';
import { FeaturedChallengeEvents } from '~/components/Challenge/FeaturedChallengeEvents';
import { ChallengeFeedFilters } from '~/components/Filters/FeedFilters/ChallengeFeedFilters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import {
  parseStatusQuery,
  parseParticipationQuery,
} from '~/components/Challenge/Infinite/ChallengeFiltersDropdown';
import { ChallengeSort } from '~/server/schema/challenge.schema';
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
  const [infoOpened, { open: openInfo, close: closeInfo }] = useDisclosure(false);

  // Parse query params
  const sort = (router.query.sort as ChallengeSort) || ChallengeSort.Newest;
  const statusFilters = parseStatusQuery(router.query.status);
  const statusArray = statusFilters
    .map((s) => statusMap[s])
    .filter((s): s is ChallengeStatus => s != null);
  const includeEnded = statusFilters.includes('completed');
  const participation = parseParticipationQuery(router.query.participation);

  const mine = router.query.engagement === 'created';
  const [myStatus, setMyStatus] = useState<'Scheduled' | 'Active' | 'Completed'>('Scheduled');

  const myStatusFilters: Record<string, Partial<GetInfiniteChallengesInput>> = {
    Scheduled: { status: [ChallengeStatus.Scheduled], includeEnded: false },
    Active: { status: [ChallengeStatus.Active], includeEnded: false },
    Completed: { status: [ChallengeStatus.Completed], includeEnded: true },
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
              data={['Scheduled', 'Active', 'Completed']}
              value={myStatus}
              onChange={(v) => setMyStatus(v as 'Scheduled' | 'Active' | 'Completed')}
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

  return (
    <>
      <Meta
        title="AI Art Challenges | Civitai"
        description="Participate in AI art challenges, compete for prizes, and showcase your creative skills with the Civitai community"
        canonical="/challenges"
      />

      {/* Info Modal */}
      <Modal
        opened={infoOpened}
        onClose={closeInfo}
        title={<Title order={3}>How Challenges Work</Title>}
        size="lg"
        centered
      >
        <Stack gap="md">
          <div>
            <Title order={4} mb="xs">
              🎨 How It Works
            </Title>
            <Text size="sm">
              Every day, we select a new challenge featuring a specific AI model. Create images
              using the featured model and submit your best work to compete for prizes!
            </Text>
          </div>
          <div>
            <Title order={4} mb="xs">
              🏆 Winning & Rewards
            </Title>
            <Text size="sm">
              The top 3 entries are reviewed and selected by our AI judging system. Entries are
              ranked by a weighted score where theme relevance counts for 50%, so staying on-theme
              is key! Winners receive Buzz prizes and challenge points. Even if you don&apos;t win,
              you can earn participation rewards for submitting quality entries.
            </Text>
          </div>
          <div>
            <Title order={4} mb="xs">
              ⭐ Challenge Points
            </Title>
            <Text size="sm">
              Earn points by participating in challenges. Top winners get the most points, but
              everyone who participates earns something. Climb the leaderboard and show off your
              skills!
            </Text>
          </div>
          <div>
            <Title order={4} mb="xs">
              📝 Tips for Success
            </Title>
            <Text size="sm">
              • Use the featured model specified in the challenge
              <br />
              • Follow the theme or prompt provided
              <br />
              • Submit your best work - quality over quantity
              <br />• Check back daily for new challenges
            </Text>
          </div>
        </Stack>
      </Modal>

      <MasonryContainer>
        <Stack gap="md">
          {/* Featured Challenge Events */}
          <FeaturedChallengeEvents />

          {/* Daily Challenges — active + upcoming System challenges, horizontal scroll. */}
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Group gap={4} wrap="nowrap">
              <Title order={3}>Daily Challenges</Title>
              <ActionIcon variant="subtle" color="gray" onClick={openInfo}>
                <IconInfoCircle size={20} />
              </ActionIcon>
            </Group>
            <Group gap="sm" wrap="nowrap" className="shrink-0">
              {currentUser?.isModerator && (
                <Button
                  component={Link}
                  href="/moderator/challenges"
                  leftSection={<IconSettings size={16} />}
                  variant="light"
                >
                  Manage
                </Button>
              )}
              <Button
                component={Link}
                href="/challenges/winners"
                leftSection={<IconTrophy size={16} />}
                variant="light"
                color="yellow"
              >
                Daily Challenge Winners
              </Button>
            </Group>
          </Group>
          <DailyChallengesRow />

          {/* Community Challenges — user + staff-created, masonry. Sort/filter controls live inline
              here (moved off the global SubNav) since they only scope this section. Behind the
              userChallenges flag: with it off, the page shows only the daily-challenge experience. */}
          {features.userChallenges && (
            <>
              <Divider />
              <Group wrap="wrap" gap="sm">
                <Title order={3}>Community Challenges</Title>
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
            </>
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ChallengesPage, { InnerLayout: FeedLayout, announcements: true });
