import { useState } from 'react';
import { Badge, Group, Stack, Text } from '@mantine/core';
import {
  IconArrowUpRight,
  IconClock,
  IconFlag,
  IconFlagCheck,
  IconHourglassHigh,
  IconTrophy,
  IconUsers,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Popover } from '~/components/MantineOverlays';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { useFlag } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { flagCounting, flagGap, flagLeader } from '~/components/HatTurf/FlagRace/flag-race.utils';
import { FinalHourCountdown, useFlagClock } from '~/components/HatTurf/FlagRace/FlagCountdown';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import {
  FALLBACK_COLOR,
  RING_LENGTH,
  RING_RADIUS,
  ringArcs,
} from '~/components/HatTurf/hat-turf.utils';
import { useTeamColor } from '~/components/Events/events.utils';
import { abbreviateNumber } from '~/utils/number-helpers';

const RING_STROKE = 4;
const DISC_RADIUS = 14;
const HOUR_MS = 60 * 60 * 1000;

/** A home-row flag's corner badge: who holds it, its points, and once closed, who won them. */
export function FlagBadge({ imageId, className }: { imageId: number; className?: string }) {
  const found = useFlag(imageId);
  const teamColor = useTeamColor();
  const [open, setOpen] = useState(false);
  const clock = useFlagClock(found?.summary);
  if (!found) return null;
  const { summary, flag, rank } = found;
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK_COLOR;
  const closed = summary.closed;
  const counting = flagCounting(summary);
  const winners = counting ? [] : flag.winners;
  const leader = closed && winners.length === 1 ? winners[0] : flagLeader(flag.hatsByTeam);
  const finalHour = !closed && Date.now() >= new Date(summary.closesAt).getTime() - HOUR_MS;
  const arcs = ringArcs(flag.hatsByTeam);
  const label = closed
    ? counting
      ? `Flag ${rank}: closed, counting results.`
      : winners.length
      ? `Flag ${rank}: closed, ${winners.join(' and ')} won.`
      : `Flag ${rank}: closed.`
    : `Flag ${rank}: ${flag.pot} points up for grabs${leader ? `, ${leader} holds it` : ''}.`;

  return (
    <Popover
      opened={open}
      onChange={setOpen}
      withinPortal
      position="bottom-start"
      withArrow
      shadow="md"
    >
      <Popover.Target>
        <button
          type="button"
          className={clsx(classes.badge, classes.chip, finalHour && 'animate-pulse', className)}
          style={{ '--hat-turf-badge-size': '18px' } as React.CSSProperties}
          aria-label={`${label} Show details`}
          aria-expanded={open}
          data-testid="flag-badge"
          data-leader={leader ?? ''}
          data-closed={closed}
          onClick={(event) => {
            // The card is a link and this sits inside it.
            event.preventDefault();
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          <span className={classes.dial}>
            <svg viewBox="0 0 48 48" className={classes.ring} aria-hidden="true">
              <g transform="rotate(-90 24 24)">
                <circle className={classes.track} cx="24" cy="24" r={RING_RADIUS} />
                {arcs.map((arc) => (
                  <circle
                    key={arc.team}
                    className={classes.arc}
                    cx="24"
                    cy="24"
                    r={RING_RADIUS}
                    stroke={colorOf(arc.team)}
                    strokeDasharray={`${arc.length} ${RING_LENGTH - arc.length}`}
                    strokeDashoffset={-arc.offset}
                  />
                ))}
              </g>
              <circle className={classes.gap} cx="24" cy="24" r={RING_RADIUS - RING_STROKE / 2} />
              <circle
                className={clsx(classes.discFill, !leader && classes.neutral)}
                cx="24"
                cy="24"
                r={DISC_RADIUS}
                fill={leader ? colorOf(leader) : undefined}
              />
            </svg>
            <span className={classes.disc}>
              <IconFlag size={8} stroke={2.5} />
            </span>
          </span>
          <span className={classes.count} data-testid="flag-badge-pot">
            {abbreviateNumber(flag.pot)} pts
          </span>
          {closed ? (
            <span className={clsx(classes.count, classes.margin)} data-testid="flag-badge-closed">
              {counting ? 'Counting…' : winners.length ? `${winners.join(' & ')} won` : 'Closed'}
            </span>
          ) : (
            clock && (
              <span
                className={clsx(classes.count, classes.margin)}
                style={
                  clock.phase === 'final' ? { color: 'var(--mantine-color-yellow-4)' } : undefined
                }
                data-testid="flag-badge-clock"
              >
                <IconClock size={11} stroke={2.5} className="mr-0.5 inline align-[-1px]" />
                {clock.phase === 'final' ? (
                  'Any moment'
                ) : (
                  <FinalHourCountdown closesAt={summary.closesAt} />
                )}
              </span>
            )
          )}
        </button>
      </Popover.Target>
      <Popover.Dropdown p="sm" w={248} onClick={(event) => event.stopPropagation()}>
        <FlagDetails imageId={imageId} />
      </Popover.Dropdown>
    </Popover>
  );
}

/** A flag's details: its pot, the teams' hats as one bar, the viewer's team's gap, and its clock. */
function FlagDetails({ imageId }: { imageId: number }) {
  const found = useFlag(imageId);
  const feed = useTurfFeed();
  const teamColor = useTeamColor();
  const clock = useFlagClock(found?.summary);
  if (!found) return null;
  const { summary, flag, rank } = found;
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK_COLOR;
  const closed = summary.closed;
  const counting = flagCounting(summary);
  const teams = Object.entries(flag.hatsByTeam)
    .filter(([, hats]) => hats > 0)
    .sort(([, a], [, b]) => b - a);
  const total = teams.reduce((sum, [, hats]) => sum + hats, 0);
  const gap = closed ? null : flagGap(flag.hatsByTeam, feed?.team);

  return (
    <Stack gap={8} data-testid="flag-details">
      <Group justify="space-between" wrap="nowrap" gap={8}>
        <Group gap={6} wrap="nowrap">
          {closed ? <IconFlagCheck size={16} /> : <IconFlag size={16} />}
          <Text fw={700} size="sm">
            Flag #{rank}
          </Text>
        </Group>
        {closed ? (
          <Badge variant="light" color="gray" radius="xl">
            Closed
          </Badge>
        ) : (
          <Badge
            variant="light"
            color="yellow"
            radius="xl"
            leftSection={<IconTrophy size={12} />}
            data-testid="flag-details-pot"
          >
            {abbreviateNumber(flag.pot)} pts
          </Badge>
        )}
      </Group>

      {closed &&
        (counting ? (
          <Group gap={6} wrap="nowrap" c="dimmed">
            <IconHourglassHigh size={16} />
            <Text size="sm">Counting results…</Text>
          </Group>
        ) : flag.winners.length ? (
          <Group
            gap={8}
            wrap="nowrap"
            className="rounded-md px-2 py-1.5"
            style={{ backgroundColor: 'rgba(255,255,255,0.06)' }}
            data-testid="flag-details-winner"
          >
            <IconTrophy size={16} color={colorOf(flag.winners[0])} />
            <Text size="sm">
              <Text span fw={700} c={colorOf(flag.winners[0])}>
                {flag.winners.join(' & ')}
              </Text>{' '}
              {flag.winners.length > 1 ? 'split' : 'won'}{' '}
              <Text span fw={700}>
                {abbreviateNumber(flag.pot)} pts
              </Text>
            </Text>
          </Group>
        ) : (
          <Text size="sm" c="dimmed">
            Nobody placed a hat here.
          </Text>
        ))}

      {total > 0 ? (
        <div>
          <div
            className="flex h-2.5 overflow-hidden rounded-full"
            style={{ backgroundColor: 'var(--mantine-color-dark-4)' }}
            role="img"
            aria-label={teams.map(([team, hats]) => `${team} ${hats}`).join(', ')}
          >
            {teams.map(([team, hats]) => (
              <span
                key={team}
                style={{ width: `${(hats / total) * 100}%`, backgroundColor: colorOf(team) }}
              />
            ))}
          </div>
          <Group gap={10} mt={6}>
            {teams.map(([team, hats]) => (
              <Group key={team} gap={4} wrap="nowrap">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: colorOf(team) }}
                />
                <Text size="xs" fw={600} aria-label={`${team}: ${hats} hats`}>
                  {abbreviateNumber(hats)}
                </Text>
              </Group>
            ))}
          </Group>
        </div>
      ) : (
        !closed && (
          <Text size="sm" c="dimmed">
            No hats yet. Be the first.
          </Text>
        )
      )}

      {gap !== null && feed?.team && (
        <Group
          gap={6}
          wrap="nowrap"
          className="rounded-md px-2 py-1"
          style={{ backgroundColor: 'rgba(34,139,230,0.12)' }}
          data-testid="flag-details-gap"
        >
          <IconArrowUpRight size={14} />
          <Text size="xs">
            {gap > 0 ? (
              <>
                {feed.team} leads by <b>{abbreviateNumber(gap)}</b>
              </>
            ) : (
              <>
                {feed.team} needs <b>{plural(-gap + 1, 'hat', 'hats')}</b> to take it
              </>
            )}
          </Text>
        </Group>
      )}

      <Group gap={12} c="dimmed">
        <Group gap={4} wrap="nowrap">
          <IconUsers size={14} />
          <Text size="xs">{plural(flag.players, 'player', 'players')}</Text>
        </Group>
        {clock && clock.phase !== 'closed' && (
          <Group gap={4} wrap="nowrap">
            <IconClock size={14} />
            <Text size="xs">
              {clock.phase === 'final' ? (
                'Could end any moment'
              ) : (
                <>
                  Final hour in <FinalHourCountdown closesAt={summary.closesAt} />
                </>
              )}
            </Text>
          </Group>
        )}
      </Group>
    </Stack>
  );
}

const plural = (n: number, one: string, many: string) =>
  `${abbreviateNumber(n)} ${n === 1 ? one : many}`;
