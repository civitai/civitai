import { useState } from 'react';
import { Stack, Text } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import clsx from 'clsx';
import { Popover } from '~/components/MantineOverlays';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { useFlag } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import {
  flagCounting,
  flagGap,
  flagLeader,
  formatClock,
} from '~/components/HatTurf/FlagRace/flag-race.utils';
import { useFlagClock } from '~/components/HatTurf/FlagRace/FlagCountdown';
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
              <IconFlag size={10} stroke={2.5} />
            </span>
          </span>
          <span className={classes.count} data-testid="flag-badge-pot">
            {abbreviateNumber(flag.pot)} pts
          </span>
          {closed ? (
            <span className={clsx(classes.count, classes.margin)} data-testid="flag-badge-closed">
              {counting
                ? 'Counting results…'
                : winners.length
                ? `${winners.join(' & ')} won`
                : 'Closed'}
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
                ⏱ {clock.phase === 'final' ? 'Any moment' : formatClock(clock.secondsLeft)}
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

function FlagDetails({ imageId }: { imageId: number }) {
  const found = useFlag(imageId);
  const feed = useTurfFeed();
  if (!found) return null;
  const { summary, flag, rank } = found;
  const gap = flagGap(flag.hatsByTeam, feed?.team);

  return (
    <Stack gap={6}>
      <Text fw={700} size="sm">
        Flag #{rank}
        {summary.closed ? ': closed' : ''}
      </Text>
      {summary.closed ? (
        <Text size="sm">
          {!flagCounting(summary) && flag.winners.length
            ? `${flag.winners.join(' and ')} won this flag.`
            : 'This flag is done taking hats. Its result is on its way.'}
        </Text>
      ) : (
        <>
          <Text size="sm">Points up for grabs: {abbreviateNumber(flag.pot)}</Text>
          <Text size="sm">Players on this flag: {abbreviateNumber(flag.players)}</Text>
          <Text size="sm" c="dimmed">
            The race ends at a random moment in its final hour.
          </Text>
          {gap !== null && feed?.team && (
            <Text size="sm">
              {gap > 0
                ? `${feed.team} leads by ${abbreviateNumber(gap)} hats`
                : gap === 0
                ? `${feed.team} is level with the lead`
                : `${feed.team} is behind by ${abbreviateNumber(-gap)} hats`}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Add hats with the hat button on the flag.
          </Text>
        </>
      )}
    </Stack>
  );
}
