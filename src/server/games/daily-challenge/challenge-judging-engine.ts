import type { JudgingCategory } from '~/server/games/daily-challenge/daily-challenge-scoring';

export const JUDGING_ENGINES = {
  LegacyAbsolute: 'legacy-absolute',
  PairwiseLadder: 'pairwise-ladder',
} as const;

export type JudgingEngineKey = (typeof JUDGING_ENGINES)[keyof typeof JUDGING_ENGINES];

export const DEFAULT_JUDGING_ENGINE: JudgingEngineKey = JUDGING_ENGINES.LegacyAbsolute;

export function isJudgingEngineKey(value: unknown): value is JudgingEngineKey {
  return Object.values(JUDGING_ENGINES).includes(value as JudgingEngineKey);
}

export type JudgingEngineContext = {
  challengeId: number;
  collectionId: number;
  theme: string;
  themeElements?: string[];
  /** The challenge's own rubric — creator-defined when it has one, the fixed split otherwise. */
  categories: JudgingCategory[];
  /** Per-category criteria text, keyed by category key, for prompts that want it. */
  criteriaByKey?: Record<string, string>;
  /**
   * When close-time judging started, for the CUMULATIVE budget. The completion claim covers every
   * stage together, so a per-stage budget lets two stages of six minutes each pass their own check
   * and blow the claim between them.
   */
  startedAt?: number;
};

/** One entry, as it exists the moment the absolute pass finishes with it. */
export type JudgedEntryRef = {
  imageId: number;
  userId: number;
  username: string;
  /** Raw Image.url. */
  url: string;
  nsfwLevel: number;
};

/**
 * An entry that survived the absolute pass's theme gate and the caller's eligibility rules
 * (winner cooldown, per-user best). Engines order these; they never widen the set.
 */
export type RankableEntry = {
  imageId: number;
  userId: number;
  username: string;
  weightedRating: number;
};

export type EngineWinner = { userId: number; imageId: number; reason: string };

/**
 * How a challenge decides who is ahead. Each engine owns how it gets its own data: the legacy
 * engine reads what the absolute pass already writes to `CollectionItem.note`, the pairwise engine
 * owns its own tables. There is deliberately no shared storage and no migration between them.
 */
export interface ChallengeJudgingEngine {
  readonly key: JudgingEngineKey;

  /**
   * Whether the engine wants the whole eligible field or the caller's top-N cut.
   *
   * The cut is by ABSOLUTE score with a `Math.random()` tiebreak. For the legacy engine that is
   * simply how it has always worked. For anything that ranks by comparison it would mean the coin
   * flip still decides who is eligible to be ranked at all — the field would be chosen by the
   * mechanism the ranking exists to replace, and the ranking would only reorder the survivors.
   */
  readonly ranksFullField: boolean;

  /**
   * How many of the ranked leaders the engine's own winner selection looks at, or 0 if it has
   * none. The recap must cover at least this many: the podium exists precisely so an entry the
   * ladder placed outside the top N can still win, and a recap that never saw it would describe a
   * challenge somebody else won.
   */
  readonly shortlistSize: number;

  /**
   * Called once per entry as it is judged on submission, after the absolute pass. Runs inside the
   * review job's per-entry error boundary, so a throw costs this entry's placement and nothing
   * else — `rankField` places anything that was missed.
   */
  recordEntry(ctx: JudgingEngineContext, entry: JudgedEntryRef): Promise<void>;

  /**
   * Order the eligible field, best first, at close. MUST return every entry it was given: the
   * caller asserts coverage, because a silently shortened field reads as a clean result.
   */
  rankField<T extends RankableEntry>(ctx: JudgingEngineContext, eligible: T[]): Promise<T[]>;

  /**
   * Winners in place order, or null when the engine has no opinion and the caller should run its
   * own winner pick.
   */
  selectWinners<T extends RankableEntry>(
    ctx: JudgingEngineContext,
    ranked: T[],
    places: number
  ): Promise<EngineWinner[] | null>;
}

/**
 * The entries the recap is written from. Both prefixes of the same ranking, so the union is
 * simply the longer one.
 */
export function recapField<T>(
  rankedField: T[],
  finalReviewAmount: number,
  engine: Pick<ChallengeJudgingEngine, 'shortlistSize'>
): T[] {
  return rankedField.slice(0, Math.max(finalReviewAmount, engine.shortlistSize));
}
