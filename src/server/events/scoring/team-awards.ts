import type { TeamAward } from '~/server/events/base.event';

// The awards a team holds by `until`. Every reader (live base, standings, winner, payout, chart)
// goes through this one window: inside the event, and before `until`, as an action counts before
// the cut. One naming a team the event does not have counts for nobody; the config test catches it.
export const teamAwardsBy = (
  event: {
    startDate: Date;
    endDate: Date;
    teams: readonly string[];
    scoring?: { teamAwards?: readonly TeamAward[] };
  },
  until: Date
) =>
  (event.scoring?.teamAwards ?? []).filter(
    (a) =>
      a.at >= event.startDate &&
      a.at < event.endDate &&
      a.at < until &&
      event.teams.includes(a.team)
  );
