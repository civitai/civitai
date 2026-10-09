import { Group, Progress, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconChartLine, IconFlame, IconTrophy } from '@tabler/icons-react';
import type { ChartOptions } from 'chart.js';
import {
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  TimeScale,
  Tooltip as ChartTooltip,
} from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import { useTeamColor } from '~/components/Events/events.utils';
import { EventSectionHeading } from '~/components/Events/ScoredEvent/EventSectionHeading';
import { teamPositionsOverTime } from '~/components/Events/ScoredEvent/scored-event.utils';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, ChartTooltip);

type Standings = RouterOutput['event']['getStandings'];

export function TeamStandings({ standings, myTeam }: { standings: Standings; myTeam?: string }) {
  const teamColor = useTeamColor();
  const [mode, setMode] = useState<'points' | 'position'>('points');
  const lead = standings.teams[0]?.score ?? 0;
  const teams = standings.teams.length;

  const data = useMemo(() => {
    if (mode === 'points')
      return {
        datasets: standings.history.map(({ team, scores }) => ({
          label: team,
          data: scores.map((s) => ({ x: s.date.getTime(), y: s.score })),
          borderColor: teamColor(team),
          backgroundColor: teamColor(team),
          borderWidth: team === myTeam ? 4 : 2,
        })),
      };
    return {
      datasets: teamPositionsOverTime(standings.history).map(({ team, positions }) => ({
        label: team,
        data: positions.map((p) => ({ x: p.date.getTime(), y: p.position })),
        borderColor: teamColor(team),
        backgroundColor: teamColor(team),
        borderWidth: team === myTeam ? 4 : 2,
      })),
    };
  }, [mode, standings.history, teamColor, myTeam]);

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      elements: { point: { radius: 3 } },
      scales: {
        x: { type: 'time', time: { unit: 'day' }, grid: { display: false } },
        y:
          mode === 'points'
            ? {
                grid: { color: 'rgba(128,128,128,0.15)' },
                ticks: { callback: (v) => abbreviateNumber(Number(v)) },
              }
            : {
                reverse: true,
                min: 1,
                max: teams,
                ticks: { stepSize: 1, callback: (v) => `#${v}` },
                grid: { color: 'rgba(128,128,128,0.15)' },
              },
      },
      plugins: { legend: { display: false } },
    }),
    [mode, teams]
  );

  return (
    <Stack gap="md">
      <EventSectionHeading
        icon={IconTrophy}
        title="Team standings"
        color={myTeam && teamColor(myTeam)}
        subtitle={
          <>
            Updated hourly · last update{' '}
            {standings.updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </>
        }
      />

      <div className="grid gap-4 @md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Stack gap="sm">
          {standings.teams.map((t) => {
            const color = teamColor(t.team) ?? 'gray';
            const mine = t.team === myTeam;
            return (
              <SpotlightBorderCard key={t.team} color={color} size={200}>
                <Group gap="md" p="md" wrap="nowrap">
                  <Text fw={800} fz={28} w={28} ta="center">
                    {t.rank}
                  </Text>
                  <Stack gap={6} className="min-w-0 flex-1">
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Text fw={700} c={color} truncate>
                        Team {t.team}
                        {mine && (
                          <Text component="span" size="xs" c="dimmed" fw={500}>
                            {' '}
                            (your team)
                          </Text>
                        )}
                      </Text>
                      <Text fw={700} className="tabular-nums">
                        {numberWithCommas(t.score)}
                      </Text>
                    </Group>
                    <Progress
                      value={lead ? (t.score / lead) * 100 : 0}
                      color={t.team.toLowerCase()}
                      radius="xl"
                      size="sm"
                      aria-label={`Team ${t.team} score`}
                    />
                  </Stack>
                </Group>
              </SpotlightBorderCard>
            );
          })}
        </Stack>

        <SpotlightBorderCard color="var(--mantine-color-blue-5)" size={320}>
          <Stack gap="sm" p="md" h="100%">
            <Group justify="space-between">
              <Group gap={6}>
                <IconChartLine size={18} />
                <Text fw={700}>
                  {mode === 'points' ? 'Points over time' : 'Positions over time'}
                </Text>
              </Group>
              <SegmentedControl
                size="xs"
                radius="xl"
                value={mode}
                onChange={(v) => setMode(v as typeof mode)}
                data={[
                  { label: 'Points', value: 'points' },
                  { label: 'Position', value: 'position' },
                ]}
              />
            </Group>
            <div className="relative min-h-[240px] flex-1">
              {standings.history.some((h) => h.scores.length) ? (
                <Line options={options} data={data} />
              ) : (
                <Text size="sm" c="dimmed" ta="center" pt="xl">
                  The chart starts after the first hour of scoring.
                </Text>
              )}
            </div>
          </Stack>
        </SpotlightBorderCard>
      </div>
    </Stack>
  );
}

export function TopHats({ standings }: { standings: Standings }) {
  const teamColor = useTeamColor();
  const top = standings.topCosmetics.slice(0, 10);
  if (!top.length) return null;

  return (
    <Stack gap="md">
      <EventSectionHeading
        icon={IconFlame}
        title="Hardest-working hats"
        color="orange"
        subtitle="The hats that have earned the most points so far."
      />
      <SpotlightBorderCard color="var(--mantine-color-yellow-5)" size={320}>
        <Stack gap={0}>
          {top.map((c, i) => {
            const cosmetic = standings.cosmetics[c.cosmeticId];
            return (
              <Group
                key={`${c.userId}:${c.cosmeticId}:${c.claimKey}`}
                gap="md"
                px="md"
                py="sm"
                wrap="nowrap"
                className="border-0 border-b border-solid border-gray-2 last:border-b-0 dark:border-dark-4"
              >
                <Text fw={700} c="dimmed" w={20} ta="right">
                  {i + 1}
                </Text>
                <div className="w-8 shrink-0">
                  {cosmetic?.url && <EdgeMedia src={cosmetic.url} width={64} alt="" />}
                </div>
                <Stack gap={0} className="min-w-0 flex-1">
                  <Text fw={600} truncate>
                    {cosmetic?.name ?? 'Hat'}
                  </Text>
                  <UserAvatar
                    userId={c.userId}
                    user={standings.users[c.userId]}
                    avatarSize="xs"
                    withUsername
                    linkToProfile
                  />
                </Stack>
                <Text fw={700} c={teamColor(c.team)} className="tabular-nums">
                  {numberWithCommas(c.points)}
                </Text>
              </Group>
            );
          })}
        </Stack>
      </SpotlightBorderCard>
    </Stack>
  );
}
