import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconSwords, IconChevronRight } from '@tabler/icons-react';
import Link from 'next/link';
import { MyChallengeCard } from '~/components/Cards/MyChallengeCard';
import { SectionBand } from '~/components/Challenge/SectionBand';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Horizontal row of the current user's own challenges — entered or created — including its own
 * section header so the whole section disappears when there's nothing to show. Renders nothing
 * while logged out, while fetching, or when the user has none: most users have none, so a
 * skeleton band here would flash a titled personal section at them and then remove it.
 */
export function YourChallengesRow() {
  const currentUser = useCurrentUser();
  const {
    data: challenges,
    isLoading,
    isRefetching,
  } = trpc.challenge.getMyChallenges.useQuery(
    { limit: 6 },
    { enabled: !!currentUser, trpc: { context: { skipBatch: true } } }
  );

  const { items: filtered, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: challenges ?? [],
    isRefetching,
  });

  const headerLeft = (
    <Group gap={9} wrap="nowrap" align="center">
      <IconSwords size={20} color="var(--mantine-color-grape-5)" />
      <div>
        <Title order={3}>Your Challenges</Title>
        <Text size="xs" c="dimmed">
          Challenges you&apos;ve entered or created
        </Text>
      </div>
    </Group>
  );

  if (!currentUser) return null;
  if (isLoading || loadingPreferences) return null;
  if (filtered.length === 0) return null;

  return (
    <SectionBand>
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          {headerLeft}
          <Button
            component={Link}
            href="/challenges?engagement=participated"
            variant="subtle"
            size="compact-sm"
            rightSection={<IconChevronRight size={16} />}
          >
            See all
          </Button>
        </Group>
        <TwScrollX className="flex gap-4">
          {filtered.map((challenge) => (
            <div key={challenge.id} className="w-[320px] shrink-0">
              <MyChallengeCard data={challenge} />
            </div>
          ))}
        </TwScrollX>
      </Stack>
    </SectionBand>
  );
}
