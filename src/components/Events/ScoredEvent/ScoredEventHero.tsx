import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconCalendarEvent, IconConfetti, IconEye, IconTrophy } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HeroBulbs } from '~/components/Events/ScoredEvent/HeroBulbs';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { AnimatedCount } from '~/components/Metrics/AnimatedCount';
import { SpotlightGlow, SpotlightSurface } from '~/components/SpotlightCard/SpotlightBorderCard';
import { useTeamColor } from '~/components/Events/events.utils';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';

type EventData = RouterOutput['event']['getData'];

// Where each team's join hat floats in a hero with no art, as [right %, top %, width px, tilt deg].
const FLOAT = [
  [4, 10, 88, -14],
  [22, 52, 76, 10],
  [2, 58, 96, 16],
  [30, 6, 64, -6],
] as const;

export function ScoredEventHero({
  data,
  team,
  rank,
  teamPoints,
  points,
  ended,
  winner,
  teamHats,
  onJoin,
  joining,
}: {
  data: EventData;
  /** The team strictly ahead once the event has ended; scores settle for a day after the end. */
  winner?: string;
  teamHats?: { team: string; url: string | null }[];
  /** The viewer's team once they have joined. */
  team?: string;
  rank?: number;
  teamPoints?: number;
  /** What the viewer's own hats earned. */
  points?: number;
  ended: boolean;
  onJoin: () => void;
  joining: boolean;
}) {
  const teamColor = useTeamColor();
  const now = new Date();
  const started = data.startDate <= now;
  const page = data.page;
  const colors = data.teams.map((t) => teamColor(t)).filter((c): c is string => !!c);
  const winnerColor = winner ? teamColor(winner) : undefined;
  const myHat = team ? teamHats?.find((h) => h.team === team)?.url : undefined;
  const eyebrowColor = (team && teamColor(team)) ?? colors[2] ?? 'var(--mantine-color-dimmed)';

  return (
    <SpotlightSurface className="overflow-hidden rounded-xl border border-solid border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-6">
      {page?.heroImage ? (
        <div
          aria-hidden
          className="relative aspect-[4/3] w-full @md:absolute @md:inset-0 @md:aspect-auto"
          data-testid="hero-art"
        >
          <EdgeMedia
            src={page.heroImage}
            width={1600}
            className="absolute inset-0 size-full object-cover object-right"
            alt=""
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent from-50% to-white @md:bg-gradient-to-r @md:from-white @md:from-35% @md:via-white/80 @md:via-50% @md:to-transparent @md:to-70% dark:to-dark-6 dark:@md:from-dark-6 dark:@md:via-dark-6/80" />
        </div>
      ) : (
        <div aria-hidden className="pointer-events-none absolute inset-0 hidden @md:block">
          {teamHats?.map(
            (hat, i) =>
              hat.url && (
                <div
                  key={hat.team}
                  className="absolute"
                  style={{
                    right: `${FLOAT[i % FLOAT.length][0]}%`,
                    top: `${FLOAT[i % FLOAT.length][1]}%`,
                    width: FLOAT[i % FLOAT.length][2],
                    transform: `rotate(${FLOAT[i % FLOAT.length][3]}deg)`,
                  }}
                >
                  <EdgeMedia src={hat.url} width={128} alt="" />
                </div>
              )
          )}
        </div>
      )}
      {winnerColor && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: `color-mix(in srgb, ${winnerColor} 14%, transparent)` }}
        />
      )}
      <HeroBulbs colors={colors} />
      <SpotlightGlow color="light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06))" size={600} />

      <Stack gap="lg" p={{ base: 'lg', sm: 40 }} className="relative @md:max-w-[56%]">
        <Group gap="xs">
          {data.preview && (
            <Badge color="yellow" variant="light" leftSection={<IconEye size={14} />}>
              Preview: testers and mods
            </Badge>
          )}
          <Badge color="gray" variant="light" leftSection={<IconCalendarEvent size={14} />}>
            {page?.dates ??
              `${formatDate(data.startDate, 'MMM D')} to ${formatDate(
                new Date(data.endDate.getTime() - 1),
                'MMM D'
              )}`}
          </Badge>
        </Group>

        <Stack gap={8}>
          <Text size="sm" fw={700} tt="uppercase" lts={0.5} c={winnerColor ?? eyebrowColor}>
            {data.title}
          </Text>
          <Title order={1} className="text-4xl leading-tight [text-wrap:balance] @sm:text-5xl">
            {winner ? (
              <>
                Team {winner} wins
                <span className="block" style={{ color: winnerColor }}>
                  {data.title}
                </span>
              </>
            ) : (
              <>
                {page?.headline ?? data.title}
                {page?.headlineAccent && (
                  <span
                    className="block bg-clip-text text-transparent"
                    style={{ backgroundImage: `linear-gradient(90deg, ${colors.join(', ')})` }}
                  >
                    {page.headlineAccent}
                  </span>
                )}
              </>
            )}
          </Title>
          {page?.summary && !ended && (
            <Text size="lg" c="dimmed" maw={480}>
              {page.summary}
            </Text>
          )}
        </Stack>

        {ended ? (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              {!winner && 'The final standings are a tie at the top. '}Ended{' '}
              {formatDate(data.endDate, 'MMMM D')}.
            </Text>
            {winner && page?.prize && (
              <Group gap="md" wrap="nowrap" data-testid="hero-prize">
                {page.prize.imageUrl ? (
                  <div className="w-16 shrink-0">
                    <EdgeMedia src={page.prize.imageUrl} width={128} alt="" />
                  </div>
                ) : (
                  <IconTrophy size={40} color={winnerColor} className="shrink-0" />
                )}
                <Stack gap={2}>
                  <Text fw={700}>{page.prize.title}</Text>
                  <Text size="sm" c="dimmed">
                    {page.prize.body}
                  </Text>
                </Stack>
              </Group>
            )}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {started ? (
              <>
                <Text component="span" fw={700} c="var(--mantine-color-text)">
                  <Countdown endTime={data.endDate} />
                </Text>{' '}
                left to score
              </>
            ) : (
              <>
                Opens to everyone in{' '}
                <Text component="span" fw={700} c="var(--mantine-color-text)">
                  <Countdown endTime={data.startDate} />
                </Text>
              </>
            )}
          </Text>
        )}

        {team ? (
          <Group
            gap="lg"
            className="max-w-full rounded-lg border border-solid px-4 py-3 @sm:w-fit"
            style={{ borderColor: teamColor(team) }}
            data-testid="hero-team"
          >
            <Group gap="sm" wrap="nowrap">
              {myHat && (
                <div className="w-14 shrink-0">
                  <EdgeMedia src={myHat} width={112} alt="" />
                </div>
              )}
              <Stack gap={0}>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700} lts={0.5}>
                  You&apos;re on
                </Text>
                <Text fw={800} size="xl" c={teamColor(team)} className="whitespace-nowrap">
                  Team {team}
                </Text>
              </Stack>
            </Group>
            <Group gap="lg" wrap="nowrap">
              {!!rank && <Figure label="Rank" value={`#${rank}`} />}
              <Figure label="Team points" value={<AnimatedCount value={teamPoints ?? 0} />} />
              <Figure label="Your hats" value={<AnimatedCount value={points ?? 0} />} />
            </Group>
          </Group>
        ) : (
          !ended && (
            <Group gap="sm">
              <LoginRedirect reason="perform-action">
                <Button
                  size="lg"
                  radius="xl"
                  onClick={onJoin}
                  loading={joining}
                  leftSection={<IconConfetti size={20} />}
                >
                  Join and get your free hat
                </Button>
              </LoginRedirect>
              <Text size="sm" c="dimmed">
                You get a random team. Teams are final.
              </Text>
            </Group>
          )
        )}
      </Stack>
    </SpotlightSurface>
  );
}

function Figure({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack gap={0} className="shrink-0">
      <Text fw={800} size="xl" className="tabular-nums">
        {value}
      </Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}
