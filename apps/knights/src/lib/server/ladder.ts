import { RANK_LADDER } from './progression/config';

export type LadderRow = {
  rank: string;
  fromLevel: number;
  accuracyBar: number;
  minDaysPlayed?: number;
};

/**
 * The ladder as the pages read it. `minDaysPlayed` is an optional field of a ladder row (a rank may ask for time served as well
 * as level and accuracy); it is passed through when the config has it, so no page names a level or a day count itself.
 */
export function ladderRows(): LadderRow[] {
  return RANK_LADDER.map((entry) => {
    const days = (entry as { minDaysPlayed?: number }).minDaysPlayed;
    return {
      rank: entry.rank,
      fromLevel: entry.fromLevel,
      accuracyBar: entry.accuracyBar,
      ...(days ? { minDaysPlayed: days } : {}),
    };
  });
}
