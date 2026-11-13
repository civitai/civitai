import { Text } from '@mantine/core';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import classes from '~/components/HatTurf/HatTurfStandings.module.css';
import type { TurfSummary } from '~/components/HatTurf/hat-turf.utils';
import { teamStandings } from '~/components/HatTurf/hat-turf.utils';
import { abbreviateNumber } from '~/utils/number-helpers';

const FALLBACK = 'var(--mantine-color-gray-6)';

/** Every team's hats on one image, the viewer's team marked, and what it would take to lead. */
export function HatTurfStandings({
  summary,
  viewerTeam,
}: {
  summary: Pick<TurfSummary, 'counted' | 'leader' | 'hatted'>;
  viewerTeam: string | null;
}) {
  const teamColor = useTeamColor();
  const { rows, lead, toTake } = teamStandings(summary, viewerTeam);
  const colorOf = (team: string) => teamColor(team) ?? FALLBACK;
  const most = rows[0]?.count ?? 0;

  return (
    <div data-testid="hat-turf-standings">
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
        Hats on this image
      </Text>
      {!rows.length && <Text size="sm">No hats yet. Be the first.</Text>}
      {rows.map(({ team, count }) => (
        <div
          key={team}
          className={clsx(classes.row, team === viewerTeam && classes.mine)}
          data-team={team}
        >
          <span className={classes.swatch} style={{ backgroundColor: colorOf(team) }} />
          <span className={classes.name}>
            {team}
            {team === viewerTeam && <span className={classes.you}> · you</span>}
          </span>
          <span className={classes.bar}>
            <i
              style={{
                width: `${most ? (count / most) * 100 : 0}%`,
                backgroundColor: colorOf(team),
              }}
            />
          </span>
          <span className={classes.count}>{abbreviateNumber(count)}</span>
        </div>
      ))}
      {summary.hatted ? (
        <Text size="xs" className={classes.note} data-testid="hat-turf-standings-note">
          A hat protects this image: hats here earn nothing until it comes off.
        </Text>
      ) : (
        lead && (
          <Text size="xs" className={classes.note} data-testid="hat-turf-standings-note">
            {lead} holds this image.
            {toTake !== null && (
              <>
                {' '}
                {viewerTeam} needs <b>{toTake} more</b> to take it.
              </>
            )}
          </Text>
        )
      )}
    </div>
  );
}
