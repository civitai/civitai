import { useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import clsx from 'clsx';
import { Popover } from '~/components/MantineOverlays';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { useFlag } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { flagGap, flagLeader } from '~/components/HatTurf/FlagRace/flag-race.utils';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import {
  FALLBACK_COLOR,
  RING_LENGTH,
  RING_RADIUS,
  formatMargin,
  ringArcs,
} from '~/components/HatTurf/hat-turf.utils';
import { useChosenHat, useHatStock, useJoin } from '~/components/HatTurf/useHatTurf';
import { useTeamColor } from '~/components/Events/events.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const RING_STROKE = 4;
const DISC_RADIUS = 14;
const FLAG_HAT_COUNTS = [1, 5, 10] as const;
const HOUR_MS = 60 * 60 * 1000;

/** A home-row flag's corner badge: who holds it, the points up for grabs, and the viewer's gap. */
export function FlagBadge({ imageId, className }: { imageId: number; className?: string }) {
  const found = useFlag(imageId);
  const feed = useTurfFeed();
  const teamColor = useTeamColor();
  const [open, setOpen] = useState(false);
  if (!found) return null;
  const { summary, flag, rank } = found;
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK_COLOR;
  const closed = summary.closed;
  const winners = flag.winners;
  const leader = closed && winners.length === 1 ? winners[0] : flagLeader(flag.hatsByTeam);
  const gap = closed ? null : flagGap(flag.hatsByTeam, feed?.team);
  const finalHour = !closed && Date.now() >= new Date(summary.closesAt).getTime() - HOUR_MS;
  const arcs = ringArcs(flag.hatsByTeam);
  const label = closed
    ? winners.length
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
              <IconFlag size={14} stroke={2.5} />
            </span>
          </span>
          {closed ? (
            <span className={classes.count} data-testid="flag-badge-closed">
              {winners.length ? `${winners.join(' & ')} won` : 'Closed'}
            </span>
          ) : (
            <span className={classes.count} data-testid="flag-badge-pot">
              {abbreviateNumber(flag.pot)} pts
            </span>
          )}
          {gap !== null && feed?.team && (
            <span className={clsx(classes.count, classes.margin)} data-testid="flag-badge-gap">
              <span
                className="mr-1 inline-block size-2 rounded-full"
                style={{ backgroundColor: colorOf(feed.team) }}
              />
              {formatMargin(gap)}
            </span>
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
  const user = useCurrentUser();
  const stock = useHatStock();
  const { cosmeticId } = useChosenHat();
  const utils = trpc.useUtils();
  const join = useJoin();
  const place = trpc.hatTurf.placeFlagHats.useMutation({
    onSuccess: (standing) => {
      // The shared summary is cached for everyone; show the placer their flag's fresh counts now.
      utils.hatTurf.getFlags.setData({ event: found?.event ?? '' }, (current) =>
        current
          ? {
              ...current,
              flags: current.flags.map((f) => (f.imageId === standing.imageId ? standing : f)),
            }
          : current
      );
      void utils.hatTurf.getStock.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't add hats", error }),
  });
  if (!found) return null;
  const { event, summary, flag, rank } = found;
  const gap = flagGap(flag.hatsByTeam, feed?.team);
  const left = stock ? Math.floor(stock.available) : 0;

  return (
    <Stack gap={6}>
      <Text fw={700} size="sm">
        Flag #{rank}
        {summary.closed ? ': closed' : ''}
      </Text>
      {summary.closed ? (
        <Text size="sm">
          {flag.winners.length
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
          {!user ? null : !feed?.joined ? (
            <Button
              size="xs"
              loading={join.isPending}
              onClick={() => join.mutate({ event, optedIn: true })}
            >
              Join Hat Turf to add hats
            </Button>
          ) : (
            <>
              <Group gap={6} grow>
                {FLAG_HAT_COUNTS.map((count) => (
                  <Button
                    key={count}
                    size="xs"
                    variant="light"
                    disabled={!cosmeticId || left < count || place.isPending}
                    data-testid={`flag-add-${count}`}
                    onClick={() =>
                      cosmeticId && place.mutate({ event, imageId, cosmeticId, count })
                    }
                  >
                    +{count}
                  </Button>
                ))}
              </Group>
              <Text size="xs" c="dimmed">
                You have {left} hats. Hats on a flag don&apos;t earn turf.
              </Text>
            </>
          )}
        </>
      )}
    </Stack>
  );
}
