import { Group, Paper, Progress, SegmentedControl, Stack, Text, ThemeIcon } from '@mantine/core';
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
import {
  EVENT_CARD_SURFACE,
  teamPositionsOverTime,
} from '~/components/Events/ScoredEvent/scored-event.utils';
import { SpotlightBorderCard } from '~/components/SpotlightCard/SpotlightBorderCard';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

ChartJS.register(TimeScale, LinearScale, PointElement, LineElement, ChartTooltip);

type Standings = RouterOutput['event']['getStandings'];

export function TeamStandings({
  standings,
  myTeam,
  startDate,
}: {
  standings: Standings;
  myTeam?: string;
  startDate: Date;
}) {
  const teamColor = useTeamColor();
  const [mode, setMode] = useState<'points' | 'position'>('points');
  const lead = standings.teams[0]?.score ?? 0;
  const teams = standings.teams.length;
  const hatOf = (team: string) => standings.teamHats.find((h) => h.team === team)?.url;
  const charted = standings.history.some((h) => h.scores.length);

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

      {/* Standings in the left third and the chart in the rest; stacked on a phone. */}
      <div className="grid gap-4 @md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Stack gap="xs" data-testid="standings-rows">
          {standings.teams.map((t) => {
            const color = teamColor(t.team) ?? 'gray';
            const mine = t.team === myTeam;
            const hat = hatOf(t.team);
            return (
              <Paper
                key={t.team}
                withBorder
                radius="md"
                className={EVENT_CARD_SURFACE}
                data-mine={mine || undefined}
                style={
                  mine ? { borderColor: color, boxShadow: `0 0 18px -4px ${color}` } : undefined
                }
              >
                <Group gap="sm" px="sm" py={10} wrap="nowrap">
                  <Text fw={800} fz={18} w={18} ta="center">
                    {t.rank}
                  </Text>
                  <div className="w-8 shrink-0">
                    {hat && <EdgeMedia src={hat} width={64} alt="" />}
                  </div>
                  <Stack gap={6} className="min-w-0 flex-1">
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Text fw={700} size="sm" c={color} truncate>
                        Team {t.team}
                        {mine && ' · you'}
                      </Text>
                      <Text fw={800} className="tabular-nums">
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
              </Paper>
            );
          })}
        </Stack>

        {charted ? (
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
                <Line options={options} data={data} />
              </div>
            </Stack>
          </SpotlightBorderCard>
        ) : (
          <ChartPending
            startDate={startDate}
            colors={standings.teams.map((t) => teamColor(t.team))}
          />
        )}
      </div>
    </Stack>
  );
}

// Where the chart will be, before there is anything to plot: a faint sketch of team lines behind a
// plain statement of when it fills in.
const SKETCH = [
  '0,70 20,62 40,64 60,48 80,40 100,30',
  '0,78 20,74 40,60 60,58 80,52 100,46',
  '0,82 20,80 40,74 60,70 80,62 100,60',
  '0,88 20,86 40,84 60,80 80,78 100,74',
];

function ChartPending({ startDate, colors }: { startDate: Date; colors: (string | undefined)[] }) {
  const upcoming = startDate > new Date();
  return (
    <div
      className="relative flex min-h-[240px] flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed border-gray-4 bg-gray-0 p-6 text-center dark:border-dark-3 dark:bg-dark-7"
      data-testid="chart-pending"
    >
      <svg
        aria-hidden
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full opacity-25"
      >
        {SKETCH.map((points, i) => (
          <polyline
            key={points}
            points={points}
            fill="none"
            stroke={colors[i] ?? 'currentColor'}
            strokeWidth={2}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <ThemeIcon size={72} radius="xl" variant="light" color="blue" className="relative">
        <IconChartLine size={40} />
      </ThemeIcon>
      <Stack gap={4} className="relative" maw={360}>
        <Text fw={800} size="lg">
          {upcoming ? "Competition hasn't started yet" : 'The graph is on its way'}
        </Text>
        <Text size="sm" c="dimmed">
          {upcoming
            ? `There will be a graph of every team's points here. Scoring starts ${formatDate(
                startDate,
                'MMM D'
              )}.`
            : 'It draws its first point after the first hour of scoring.'}
        </Text>
      </Stack>
    </div>
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
      {/* Card rows like the standings'. Two columns on a wide page, filled down: 1 to 5, then 6 to 10. */}
      <div
        className="grid gap-2 @md:grid-flow-col @md:grid-cols-2 @md:grid-rows-5 @md:gap-x-3"
        data-testid="top-hats"
      >
        {top.map((c, i) => {
          const cosmetic = standings.cosmetics[c.cosmeticId];
          return (
            <Paper
              key={`${c.userId}:${c.cosmeticId}:${c.claimKey}`}
              withBorder
              radius="md"
              className={EVENT_CARD_SURFACE}
            >
              <Group gap="sm" px="sm" py={10} wrap="nowrap">
                <Text fw={800} fz={18} w={24} ta="center">
                  {i + 1}
                </Text>
                <div className="w-8 shrink-0">
                  {cosmetic?.url && <EdgeMedia src={cosmetic.url} width={64} alt="" />}
                </div>
                <Stack gap={0} className="min-w-0 flex-1">
                  <Text fw={600} size="sm" truncate>
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
                <Text fw={800} c={teamColor(c.team)} className="tabular-nums">
                  {numberWithCommas(c.points)}
                </Text>
              </Group>
            </Paper>
          );
        })}
      </div>
    </Stack>
  );
}
