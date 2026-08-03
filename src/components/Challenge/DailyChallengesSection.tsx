import { ActionIcon, Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconSettings, IconCalendarEvent, IconChevronRight } from '@tabler/icons-react';
import Link from 'next/link';
import { ChallengeCard } from '~/components/Cards/ChallengeCard';
import { ChallengeCardSkeletonRow } from '~/components/Challenge/ChallengeCardSkeletonRow';
import { SectionBand } from '~/components/Challenge/SectionBand';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Self-contained Daily Challenges section: its own band, header (info modal + moderator Manage +
 * Winners links) and the active/upcoming daily-challenge row. Shows a skeleton row while fetching
 * and removes the whole section (band included) once it's confirmed there's nothing to show.
 */
export function DailyChallengesSection() {
  const currentUser = useCurrentUser();
  const [infoOpened, { open: openInfo, close: closeInfo }] = useDisclosure(false);

  const {
    data: challenges,
    isLoading,
    isRefetching,
  } = trpc.challenge.getDaily.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const { items: filteredChallenges, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: challenges ?? [],
    isRefetching,
  });

  const loading = isLoading || loadingPreferences;
  if (!loading && filteredChallenges.length === 0) return null;

  return (
    <SectionBand>
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap="xs" wrap="nowrap" align="center">
            <IconCalendarEvent size={20} color="var(--mantine-color-blue-4)" />
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
              variant="subtle"
              size="compact-sm"
              rightSection={<IconChevronRight size={16} />}
            >
              Previous winners
            </Button>
          </Group>
        </Group>

        {loading ? (
          <ChallengeCardSkeletonRow />
        ) : (
          <TwScrollX className="flex gap-4">
            {filteredChallenges.map((challenge) => (
              <div key={challenge.id} className="w-[320px] shrink-0">
                <ChallengeCard data={challenge} />
              </div>
            ))}
          </TwScrollX>
        )}
      </Stack>

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
              Every day, we select a new challenge featuring a specific AI model. Create images using
              the featured model and submit your best work to compete for prizes!
            </Text>
          </div>
          <div>
            <Title order={4} mb="xs">
              🏆 Winning & Rewards
            </Title>
            <Text size="sm">
              The top 3 entries are reviewed and selected by our AI judging system. Entries are
              ranked by a weighted score where theme relevance counts for 50%, so staying on-theme is
              key! Winners receive Buzz prizes and challenge points. Even if you don&apos;t win, you
              can earn participation rewards for submitting quality entries.
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
    </SectionBand>
  );
}
