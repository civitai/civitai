import { createContext, useContext } from 'react';
import type { FlagSummary } from '~/server/events/turf/turf.service';

export type FlagRow = { event: string; summary: FlagSummary };

/** Set around the home flag row only: which of its images are today's flags, and their counts. */
export const FlagRaceContext = createContext<FlagRow | null>(null);

export function useFlag(imageId: number) {
  const row = useContext(FlagRaceContext);
  const flag = row?.summary.flags.find((f) => f.imageId === imageId);
  if (!row || !flag) return undefined;
  const rank = row.summary.flags.indexOf(flag) + 1;
  return { event: row.event, summary: row.summary, flag, rank };
}
