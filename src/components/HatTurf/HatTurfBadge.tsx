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
 * The feed card's Hat Turf badge, top left: a ring of arcs (one per team, sized by hats that count)
 * around a disc in the leading team's colour, a white hat and the leader's count under it. When the
 * viewer's team is behind, a small "you N" pill sits beside it. Draws nothing for an image with no
 * turf. Decorative to a pointer (the card is a link); the whole standing is in its label.
 */
export function HatTurfBadge({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const teamColor = useTeamColor();
  // Animate only a change the viewer watches happen, not the first draw.
  const drawn = useRef(false);
  useEffect(() => {
    drawn.current = true;
  }, []);

  if (!summary) return null;
  const leader = badgeLeader(summary);
  const arcs = ringArcs(summary.counted);
  const behind = viewerBehind(summary, feed?.team);
  const count = leader ? summary.counted[leader] : 0;
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
              className={clsx(classes.count, drawn.current && classes.bump)}
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
