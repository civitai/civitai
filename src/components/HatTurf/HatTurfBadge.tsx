import { useState } from 'react';
import { Popover } from '~/components/MantineOverlays';
import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { HatTurfStandings } from '~/components/HatTurf/HatTurfStandings';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import {
  RING_LENGTH,
  RING_RADIUS,
  badgeLeader,
  ringArcs,
  standingsLabel,
} from '~/components/HatTurf/hat-turf.utils';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import { useTeamColor } from '~/components/Events/events.utils';
import { useExperimentExposure } from '~/components/Experiments/useExperimentExposure';
import { abbreviateNumber } from '~/utils/number-helpers';

const FALLBACK = 'var(--mantine-color-gray-6)';

/** Corner badge for an image's standings. In the `badge-popover` arm, tapping it opens every team's count. */
export function HatTurfBadge({ imageId }: { imageId: number }) {
  // Cards render by the hundred: unless the viewer joined Hat Turf, none of the badge's hooks should run.
  return useTurfFeed()?.joined ? <HatTurfBadgeContent imageId={imageId} /> : null;
}

function HatTurfBadgeContent({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const teamColor = useTeamColor();
  const track = useHatTurfAction('feed-card');
  // The badge is what differs between arms, and it shows on cards that have no hat button.
  const exposureRef = useExperimentExposure('hatTurfFeedCard', 'feed-card', {
    enabled: !!feed?.arm,
  });
  const [open, setOpen] = useState(false);
  const leader = summary ? badgeLeader(summary) : null;
  const shownCount = summary && leader ? summary.counted[leader] : null;
  // Pops only when a count the viewer already saw changes, not when the first one arrives. Held in
  // state, not derived per render, so an unrelated re-render mid-animation does not cancel it.
  const [seenCount, setSeenCount] = useState(shownCount);
  const [bump, setBump] = useState(false);
  if (shownCount !== seenCount) {
    setSeenCount(shownCount);
    setBump(seenCount !== null && shownCount !== null);
  }

  if (!summary || !feed) return null;
  const arcs = ringArcs(summary.counted);
  const count = shownCount ?? 0;
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK;
  // A protected image is held by its hat's team, whoever leads the count.
  const holder = summary.hatted && summary.hattedTeam ? summary.hattedTeam : leader;
  const discColor = holder ? colorOf(holder) : undefined;

  const label = `${standingsLabel(summary, feed.team)}${
    summary.hatted
      ? summary.hattedTeam
        ? ` A ${summary.hattedTeam} hat protects this image.`
        : ' A hat protects this image.'
      : ''
  }`;
  const face = (
    <>
      <svg viewBox="0 0 48 48" className={classes.ring} aria-hidden="true">
        <circle className={classes.track} cx="24" cy="24" r={RING_RADIUS} />
        {arcs.map((arc) => (
          <circle
            key={arc.team}
            className={classes.arc}
            data-team={arc.team}
            cx="24"
            cy="24"
            r={RING_RADIUS}
            stroke={colorOf(arc.team)}
            strokeDasharray={`${arc.length} ${RING_LENGTH - arc.length}`}
            strokeDashoffset={-arc.offset}
          />
        ))}
      </svg>
      <div
        className={clsx(classes.disc, !discColor && classes.neutral)}
        style={discColor ? { backgroundColor: discColor } : undefined}
        data-testid="hat-turf-disc"
      >
        <span
          className={classes.hat}
          style={discColor ? { color: `color-mix(in srgb, ${discColor} 55%, black)` } : undefined}
        >
          <HatIcon size={discColor ? 26 : 20} />
        </span>
        {leader && (
          <span
            key={count}
            className={clsx(classes.count, bump && classes.bump)}
            data-testid="hat-turf-count"
          >
            {abbreviateNumber(count)}
          </span>
        )}
      </div>
      {summary.hatted && (
        <span className={classes.lock} data-testid="hat-turf-badge-lock">
          <IconLock size={10} stroke={2.75} />
        </span>
      )}
    </>
  );

  if (feed.arm !== 'badge-popover') {
    return (
      <div
        ref={exposureRef}
        className={clsx(classes.badge, classes.passive)}
        role="img"
        aria-label={label}
        data-testid="hat-turf-badge"
        data-leader={leader ?? ''}
      >
        {face}
      </div>
    );
  }

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
          ref={exposureRef}
          type="button"
          className={classes.badge}
          aria-label={`${label} Show teams`}
          aria-expanded={open}
          data-testid="hat-turf-badge"
          data-leader={leader ?? ''}
          onClick={(event) => {
            // The card is a link and this sits inside it.
            event.preventDefault();
            event.stopPropagation();
            if (!open) track('hat_count_open', feed.event);
            setOpen(!open);
          }}
        >
          {face}
        </button>
      </Popover.Target>
      <Popover.Dropdown p="sm" w={224} onClick={(event) => event.stopPropagation()}>
        <HatTurfStandings summary={summary} viewerTeam={feed.team} />
      </Popover.Dropdown>
    </Popover>
  );
}
