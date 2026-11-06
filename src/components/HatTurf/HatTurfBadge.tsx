import { useState } from 'react';
import { Popover } from '~/components/MantineOverlays';
import { IconLock } from '@tabler/icons-react';
import clsx from 'clsx';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { HatTurfStandings } from '~/components/HatTurf/HatTurfStandings';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import {
  FALLBACK_COLOR,
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

// In the ring's 48-unit viewBox.
const RING_STROKE = 4;
const DISC_RADIUS = 14;

/** Corner badge for an image's standings. In the `badge-popover` arm, tapping it opens every team's count. */
export function HatTurfBadge({ imageId, className }: { imageId: number; className?: string }) {
  // Cards render by the hundred: unless the viewer joined Hat Turf, none of the badge's hooks should run.
  const joined = !!useTurfFeed()?.joined;
  return joined ? <HatTurfBadgeContent imageId={imageId} className={className} /> : null;
}

function HatTurfBadgeContent({ imageId, className }: { imageId: number; className?: string }) {
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
  // A hatted image scores for its hat's team alone; a different leader's count is shown as blocked.
  const guard = summary?.hatted ? summary.hattedTeam : null;
  const holder = guard ?? leader;
  const blocked = guard && leader && leader !== guard ? leader : null;
  const shownCount = summary && holder ? summary.counted[holder] ?? 0 : null;
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
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK_COLOR;
  const discColor = holder ? colorOf(holder) : undefined;

  const label = `${standingsLabel(summary, feed.team)}${
    summary.hatted
      ? summary.hattedTeam
        ? ` A ${summary.hattedTeam} hat protects this image.`
        : ' A hat protects this image.'
      : ''
  }`;
  // Digits beyond one don't fit the dial; the count goes beside it.
  const hasCount = !!holder && count > 0;
  const countInside = hasCount && count < 10;
  const countBeside = hasCount && !countInside;
  const countEl = hasCount && (
    <span
      key={count}
      className={clsx(classes.count, countInside && classes.countInside, bump && classes.bump)}
      data-testid="hat-turf-count"
    >
      {abbreviateNumber(count)}
    </span>
  );
  const face = (
    <>
      <span className={classes.dial}>
        {/* The disc is in the ring's SVG: as a CSS box it snapped to the pixel grid on its own and,
            at a fractional x, painted up to a pixel off the ring's centre. */}
        <svg viewBox="0 0 48 48" className={classes.ring} aria-hidden="true">
          <g transform="rotate(-90 24 24)">
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
          </g>
          <circle className={classes.gap} cx="24" cy="24" r={RING_RADIUS - RING_STROKE / 2} />
          <circle
            className={clsx(classes.discFill, !discColor && classes.neutral)}
            cx="24"
            cy="24"
            r={DISC_RADIUS}
            fill={discColor}
            data-testid="hat-turf-disc-fill"
          />
        </svg>
        <span className={classes.disc} data-testid="hat-turf-disc">
          {countInside ? countEl : <HatIcon className={classes.hat} />}
        </span>
      </span>
      {countBeside && countEl}
      {blocked && (
        <span className={classes.blocked} data-testid="hat-turf-blocked" data-team={blocked}>
          <span className={classes.blockedDot} style={{ backgroundColor: colorOf(blocked) }} />
          <span
            className={clsx(classes.count, classes.struck)}
            data-testid="hat-turf-blocked-count"
          >
            {abbreviateNumber(summary.counted[blocked] ?? 0)}
          </span>
        </span>
      )}
      {summary.hatted && (
        <span className={classes.lock} data-testid="hat-turf-badge-lock">
          <IconLock stroke={2.5} />
        </span>
      )}
    </>
  );
  const chip = countBeside || summary.hatted;

  if (feed.arm !== 'badge-popover') {
    return (
      <div
        ref={exposureRef}
        className={clsx(classes.badge, chip && classes.chip, classes.passive, className)}
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
          className={clsx(classes.badge, chip && classes.chip, className)}
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
