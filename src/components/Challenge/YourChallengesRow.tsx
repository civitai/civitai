import { Button, Group, Stack, Title } from '@mantine/core';
import Link from 'next/link';
import { MyChallengeCard } from '~/components/Cards/MyChallengeCard';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Horizontal row of the current user's recently participated-in challenges, including its own
 * section header so the whole section disappears when there's nothing to show. Renders nothing
 * while logged out, loading, or when the user has no entries (mirrors DailyChallengesRow).
 */
export function YourChallengesRow() {
  const currentUser = useCurrentUser();
  const {
    data: challenges,
    isLoading,
    isRefetching,
  } = trpc.challenge.getMyParticipated.useQuery(
    { limit: 6 },
    { enabled: !!currentUser, trpc: { context: { skipBatch: true } } }
  );

  const { items: filtered, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: challenges ?? [],
    isRefetching,
  });

  if (!currentUser || isLoading || loadingPreferences || filtered.length === 0) return null;

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="nowrap">
        <Title order={3}>Your Challenges</Title>
        <Button component={Link} href="/challenges?participation=entered" variant="subtle" size="compact-sm">
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
  );
}
