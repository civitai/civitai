import { createContext, useContext } from 'react';
import type { FlagSummary, PastFlag } from '~/server/events/turf/turf.service';

export type FlagRow = { event: string; summary: FlagSummary; past?: PastFlag[] };

/** Set around the flags: today's flags and their counts, and where asked for, past days' results. */
export const FlagRaceContext = createContext<FlagRow | null>(null);

export function useFlag(imageId: number) {
  const row = useContext(FlagRaceContext);
  if (!row) return undefined;
  const flag = row.summary.flags.find((f) => f.imageId === imageId);
  if (flag) {
    const rank = row.summary.flags.indexOf(flag) + 1;
    return { event: row.event, summary: row.summary, flag, rank, pastDay: undefined };
  }
  const past = row.past?.find((f) => f.imageId === imageId);
  if (!past) return undefined;
  // A frozen day, in the shape the badge reads. Its hat counts were never kept: the ring shows the
  // winners alone.
  const summary: FlagSummary = {
    flagDayId: past.flagDayId,
    closed: true,
    cutAt: past.cutAt,
    closesAt: past.closesAt,
    flags: [],
    frozen: true,
    teamPoints: {},
  };
  return {
    event: row.event,
    summary,
    flag: {
      imageId,
      hatsByTeam: Object.fromEntries(past.winners.map((team) => [team, 1])),
      players: 0,
      pot: past.points,
      winners: past.winners,
    },
    rank: past.rank,
    pastDay: past.cutAt,
  };
}
