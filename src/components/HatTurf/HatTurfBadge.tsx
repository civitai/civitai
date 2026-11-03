import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import classes from '~/components/HatTurf/HatTurfBadge.module.css';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import {
  RING_LENGTH,
  RING_RADIUS,
  badgeLeader,
  ringArcs,
  standingsLabel,
  viewerBehind,
} from '~/components/HatTurf/hat-turf.utils';
import { useTeamColor } from '~/components/Events/events.utils';
import { abbreviateNumber } from '~/utils/number-helpers';

const FALLBACK = 'var(--mantine-color-gray-6)';

/**
 * Corner badge for an image's standings. Pointer-decorative: the card is a link, so the full
 * standing is in its aria-label.
 */
export function HatTurfBadge({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const teamColor = useTeamColor();
  const leader = summary ? badgeLeader(summary) : null;
  const shownCount = summary && leader ? summary.counted[leader] : null;
  // Pops only when a count the viewer already saw changes, not when the first one arrives.
  const previous = useRef<number | null>(null);
  const bump = previous.current !== null && shownCount !== null && previous.current !== shownCount;
  useEffect(() => {
    previous.current = shownCount;
  }, [shownCount]);

  if (!summary) return null;
  const arcs = ringArcs(summary.counted);
  const behind = viewerBehind(summary, feed?.team);
  const count = shownCount ?? 0;
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK;

  return (
    <div
      className={classes.badge}
      role="img"
      aria-label={standingsLabel(summary, feed?.team)}
      data-testid="hat-turf-badge"
      data-leader={leader ?? ''}
    >
      <div className={classes.ringBox}>
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
          className={clsx(classes.disc, !leader && classes.neutral)}
          style={leader ? { backgroundColor: colorOf(leader) } : undefined}
        >
          <HatIcon size={leader ? 15 : 18} />
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
      </div>
      {behind && (
        <span className={classes.you} style={{ color: colorOf(behind.team) }}>
          <span className={classes.youLabel}>you {abbreviateNumber(behind.count)}</span>
        </span>
      )}
    </div>
  );
}
