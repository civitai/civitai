import {
  JUDGING_ENGINES,
  type ChallengeJudgingEngine,
  type JudgingEngineContext,
  type RankableEntry,
} from '~/server/games/daily-challenge/challenge-judging-engine';

/**
 * Absolute scoring, exactly as it has always worked. The absolute pass writes
 * `CollectionItem.note`, `getJudgedEntries` reads it and sorts by weighted score, and
 * `generateWinners` picks the winners — none of which goes through this object. Every method is
 * the identity so a challenge on this engine takes the same code path it did before engines
 * existed.
 */
export const legacyAbsoluteEngine: ChallengeJudgingEngine = {
  key: JUDGING_ENGINES.LegacyAbsolute,
  ranksFullField: false,

  async recordEntry() {
    // The note write lives in the review job and is shared by every engine.
  },

  async rankField<T extends RankableEntry>(
    _ctx: JudgingEngineContext,
    eligible: T[]
  ): Promise<T[]> {
    return eligible;
  },

  async selectWinners() {
    return null;
  },
};
