import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconCalendarEvent, IconConfetti, IconEye, IconTrophy } from '@tabler/icons-react';
import { Countdown } from '~/components/Countdown/Countdown';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { SpotlightGlow, SpotlightSurface } from '~/components/SpotlightCard/SpotlightBorderCard';
import { useTeamColor } from '~/components/Events/events.utils';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

type EventData = RouterOutput['event']['getData'];

// Where each team's join hat floats in the hero, as [right %, top %, width px, tilt deg].
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
  points,
  ended,
  onJoin,
  joining,
}: {
  data: EventData;
  /** The viewer's team once they have joined. */
  team?: string;
  rank?: number;
  points?: number;
  ended: boolean;
  onJoin: () => void;
  joining: boolean;
}) {
  const teamColor = useTeamColor();
  const now = new Date();
  const started = data.startDate <= now;
  const page = data.page;

  return (
    <SpotlightSurface className="overflow-hidden rounded-xl border border-solid border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-6">
      <SpotlightGlow color="light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06))" size={600} />
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden @md:block">
        {data.teamHats?.map(
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

      <Stack gap="lg" p={{ base: 'lg', sm: 40 }} className="relative @md:max-w-[62%]">
        <Group gap="xs">
          {data.preview && (
            <Badge color="yellow" variant="light" leftSection={<IconEye size={14} />}>
              Preview: testers and mods
            </Badge>
          )}
          <Badge color="gray" variant="light" leftSection={<IconCalendarEvent size={14} />}>
            {formatDate(data.startDate, 'MMM D')} to{' '}
            {formatDate(new Date(data.endDate.getTime() - 1), 'MMM D')}
          </Badge>
        </Group>

        <Stack gap={8}>
          <Text size="sm" fw={700} tt="uppercase" c="dimmed" lts={0.5}>
            {data.title}
          </Text>
          <Title order={1} className="text-4xl leading-tight @sm:text-5xl">
            {page?.headline ?? data.title}
          </Title>
          {page?.summary && (
            <Text size="lg" c="dimmed" maw={560}>
              {page.summary}
            </Text>
          )}
        </Stack>

        <Text size="sm" c="dimmed">
          {ended ? (
            <>Ended {formatDate(data.endDate, 'MMMM D')}. Final standings below.</>
          ) : started ? (
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

        {team ? (
          <Group gap="sm">
            <Badge
              size="xl"
              radius="xl"
              variant="light"
              color={team.toLowerCase()}
              leftSection={<IconConfetti size={18} />}
            >
              You&apos;re on Team {team}
            </Badge>
            {!!rank && (
              <Text size="sm" c="dimmed">
                <IconTrophy size={14} className="inline align-[-2px]" /> #{rank} ·{' '}
                <Text component="span" fw={700} c={teamColor(team)}>
                  {numberWithCommas(points ?? 0)}
                </Text>{' '}
                points from your hats
              </Text>
            )}
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
