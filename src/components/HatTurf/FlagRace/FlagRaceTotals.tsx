import { Group, Paper, Progress, Text } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useTeamColor } from '~/components/Events/events.utils';
import { pluralize } from '~/shared/utils/pluralize';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * The bottom of the event page's Flag Race card: each team's flags won and points across the days
 * frozen so far, in the Team standings' row style. Nothing until a day has frozen.
 */
export function FlagRaceTotals({
  event,
  myTeam,
  teamHats,
}: {
  event: string;
  myTeam?: string;
  teamHats?: { team: string; url: string | null }[];
}) {
  const teamColor = useTeamColor();
  const { data } = trpc.hatTurf.getFlagRaceTotals.useQuery(
    { event },
    // Unbatched, so the edge caches it: every viewer gets the same answer.
    { staleTime: 60_000, trpc: { context: { skipBatch: true } } }
  );
  if (!data?.days) return null;
  const lead = data.teams[0]?.points ?? 0;

  return (
    <div className="col-span-full border-t border-white/10 pt-3" data-testid="flag-race-totals">
      <Group justify="space-between" mb={8} gap={8}>
        <Group gap={6}>
          <IconFlag size={14} />
          <Text size="sm" fw={700}>
            Race so far
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          All days so far · {pluralize(data.days, 'day')} done
        </Text>
      </Group>
      <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 @4xl:grid-cols-4">
        {data.teams.map((t, index) => {
          const color = teamColor(t.team) ?? 'gray';
          const mine = t.team === myTeam;
          const hat = teamHats?.find((h) => h.team === t.team)?.url;
          return (
            <Paper
              key={t.team}
              withBorder
              radius="md"
              className="bg-white/5"
              data-mine={mine || undefined}
              data-testid="flag-race-totals-team"
              style={{
                borderColor: mine ? color : 'rgba(255,255,255,0.1)',
                boxShadow: mine ? `0 0 18px -4px ${color}` : undefined,
              }}
            >
              <Group gap="sm" px="sm" py={8} wrap="nowrap">
                <Text fw={800} fz={16} w={14} ta="center">
                  {index + 1}
                </Text>
                <div className="w-7 shrink-0">
                  {hat && <EdgeMedia src={hat} width={64} alt="" />}
                </div>
                <div className="min-w-0 flex-1">
                  <Group justify="space-between" gap="xs" wrap="nowrap">
                    <Text fw={700} size="sm" c={color} truncate>
                      Team {t.team}
                      {mine && ' · you'}
                    </Text>
                    <Text fw={800} size="sm" className="whitespace-nowrap tabular-nums">
                      {numberWithCommas(t.points)}
                    </Text>
                  </Group>
                  <Group justify="space-between" gap="xs" wrap="nowrap" mt={2} mb={6}>
                    <Group gap={4} wrap="nowrap" c="dimmed">
                      <IconFlag size={12} />
                      <Text size="xs">{pluralize(t.flags, 'flag')} won</Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      points
                    </Text>
                  </Group>
                  <Progress
                    value={lead ? (t.points / lead) * 100 : 0}
                    color={t.team.toLowerCase()}
                    radius="xl"
                    size="sm"
                    aria-label={`Team ${t.team}: ${pluralize(t.flags, 'flag')} won, ${
                      t.points
                    } points`}
                  />
                </div>
              </Group>
            </Paper>
          );
        })}
      </div>
    </div>
  );
}
