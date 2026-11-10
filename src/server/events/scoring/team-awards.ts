import type { dbRead, dbWrite } from '~/server/db/client';
import type { EventScoring, TeamAward } from '~/server/events/base.event';
import { loadCrucibleTeamAwards } from '~/server/events/scoring/crucible-team-awards';

type AwardEvent = {
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  scoring?: Partial<EventScoring>;
};

// The awards a team holds by `until`. The referee's live team base and per-hour chart and the
// standings (whose first place is the winner) all read this one window: inside the event, and before
// `until`, as an action counts before the cut. One naming a team the event does not have counts for
// nobody; the config test catches it.
export const teamAwardsBy = (
  event: AwardEvent,
  until: Date,
  awards: readonly TeamAward[] = event.scoring?.teamAwards ?? []
) =>
  awards.filter(
    (a) =>
      a.at >= event.startDate &&
      a.at < event.endDate &&
      a.at < until &&
      event.teams.includes(a.team)
  );

/** The event file's awards plus those its crucible entrants earned, through the same window. */
export async function loadTeamAwards(
  event: AwardEvent & { name: string },
  until: Date,
  db?: typeof dbRead | typeof dbWrite
) {
  const earned = await loadCrucibleTeamAwards(event, until, db);
  return teamAwardsBy(event, until, [...(event.scoring?.teamAwards ?? []), ...earned]);
}
