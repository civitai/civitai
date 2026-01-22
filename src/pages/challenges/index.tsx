import { Stack, Title, Group, Text, Button, ThemeIcon, ActionIcon, Modal } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconSettings, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ChallengesInfinite } from '~/components/Challenge/Infinite/ChallengesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';

function ChallengesPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const [infoOpened, { open: openInfo, close: closeInfo }] = useDisclosure(false);

  // Parse query params
  const sort = (router.query.sort as ChallengeSort) || ChallengeSort.Newest;
  const statusFilter = (router.query.status as string) || 'active';

  // Convert status filter to API format
  const getStatusArray = () => {
    switch (statusFilter) {
      case 'active':
        return [ChallengeStatus.Active];
      case 'upcoming':
        return [ChallengeStatus.Scheduled];
      case 'completed':
        return [ChallengeStatus.Completed];
      case 'all':
        return undefined; // No filter
      default:
        return [ChallengeStatus.Active];
    }
  };

  return (
    <>
      <Meta
        title="AI Art Challenges | Civitai"
        description="Participate in AI art challenges, compete for prizes, and showcase your creative skills with the Civitai community"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/challenges`, rel: 'canonical' }]}
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
              The top 3 entries are reviewed and selected by our AI judging system. Winners receive
              Buzz prizes and challenge points! Even if you don&apos;t win, you can earn
              participation rewards for submitting quality entries.
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
          {/* Header */}
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm">
              <ThemeIcon size="xl" radius="xl" color="yellow" variant="light">
                <IconTrophy size={24} />
              </ThemeIcon>
              <div>
                <Group gap={4}>
                  <Title order={1}>Challenges</Title>
                  <ActionIcon variant="subtle" color="gray" onClick={openInfo}>
                    <IconInfoCircle size={20} />
                  </ActionIcon>
                </Group>
                <Text c="dimmed" size="sm">
                  Compete in AI art challenges and win prizes
                </Text>
              </div>
            </Group>
            {/* Future: Create challenge button for users */}
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
          </Group>

          {/* Challenge Feed */}
          <ChallengesInfinite
            filters={{
              sort,
              status: getStatusArray(),
              includeEnded: statusFilter === 'completed' || statusFilter === 'all',
            }}
          />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ChallengesPage, { InnerLayout: FeedLayout, announcements: true });
