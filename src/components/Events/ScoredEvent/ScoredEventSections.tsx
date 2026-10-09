import {
  Button,
  Card,
  getPrimaryShade,
  Group,
  Progress,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useMutateEvent } from '~/components/Events/events.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

function useTeamColor() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  return (team: string) =>
    theme.colors[team.toLowerCase()]?.[getPrimaryShade(theme, colorScheme)] ?? undefined;
}

// Team standings, the viewer's own points and cosmetics, and the top-scoring cosmetics. Scores are
// recomputed hourly by the event engine; everything here reads that snapshot.
export function ScoredEventSections({
  event,
  joined,
  ended,
}: {
  event: string;
  joined: boolean;
  ended: boolean;
}) {
  const currentUser = useCurrentUser();
  const teamColor = useTeamColor();
  const { data: standings } = trpc.event.getStandings.useQuery({ event });
  const { data: mine } = trpc.event.getMyCosmeticScores.useQuery(
    { event },
    { enabled: !!currentUser && joined }
  );
  const { activateCosmetic, equipping } = useMutateEvent();

  const handleJoin = async () => {
    try {
      await activateCosmetic({ event });
    } catch (e) {
      showErrorNotification({ title: 'Unable to join', error: e as Error });
    }
  };

  const total = standings?.teams.reduce((sum, t) => sum + t.score, 0) ?? 0;

  return (
    <Stack gap="xl">
      {!joined && !ended && (
        <LoginRedirect reason="perform-action">
          <Button
            radius="xl"
            size="lg"
            rightSection={!equipping ? <IconChevronRight /> : undefined}
            onClick={handleJoin}
            loading={equipping}
            fullWidth
          >
            {equipping ? 'Assigning team...' : 'Join and get your hat'}
          </Button>
        </LoginRedirect>
      )}

      <Card radius="lg" p="lg" className="bg-gray-0 dark:bg-dark-6">
        <Stack gap="md">
          <Title order={3}>Team standings</Title>
          {standings?.teams.map((t) => (
            <Stack key={t.team} gap={4}>
              <Group justify="space-between">
                <Text fw={600} c={teamColor(t.team)}>
                  #{t.rank} {t.team}
                </Text>
                <Text fw={600}>{numberWithCommas(t.score)}</Text>
              </Group>
              <Progress
                value={total ? (t.score / total) * 100 : 0}
                color={t.team.toLowerCase()}
                radius="xl"
              />
            </Stack>
          ))}
          {standings && (
            <Text size="xs" c="dimmed">
              Updated hourly. Last update {standings.updatedAt.toLocaleTimeString()}.
            </Text>
          )}
        </Stack>
      </Card>

      {mine && (
        <Card radius="lg" p="lg" className="bg-gray-0 dark:bg-dark-6">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={3}>Your hats</Title>
              <Text fw={700} fz="xl">
                {numberWithCommas(mine.points)} points
              </Text>
            </Group>
            {mine.cosmetics.length === 0 ? (
              <Text c="dimmed">Put a hat on your images, models or articles to start scoring.</Text>
            ) : (
              mine.cosmetics.map((c) => (
                <Group key={`${c.cosmeticId}:${c.claimKey}`} justify="space-between">
                  <Text c={teamColor(c.team)}>{c.name ?? 'Hat'}</Text>
                  <Text size="sm">
                    {numberWithCommas(c.points)} points ·{' '}
                    {numberWithCommas(c.impressions + c.anonImpressions)} views ·{' '}
                    {numberWithCommas(c.reactions)} reactions
                  </Text>
                </Group>
              ))
            )}
          </Stack>
        </Card>
      )}

      {!!standings?.topCosmetics.length && (
        <Card radius="lg" p="lg" className="bg-gray-0 dark:bg-dark-6">
          <Stack gap="md">
            <Title order={3}>Top hats</Title>
            {standings.topCosmetics.map((c, i) => (
              <Group key={`${c.userId}:${c.cosmeticId}:${c.claimKey}`} justify="space-between">
                <Group gap="sm">
                  <Text fw={600} w={32}>
                    {i + 1}
                  </Text>
                  <UserAvatar
                    userId={c.userId}
                    user={standings.users[c.userId]}
                    indicatorProps={{ color: c.team.toLowerCase() }}
                    avatarSize="sm"
                    withUsername
                    linkToProfile
                  />
                </Group>
                <Text fw={600} c={teamColor(c.team)}>
                  {numberWithCommas(c.points)}
                </Text>
              </Group>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
