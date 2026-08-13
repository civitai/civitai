import type { JudgingCategory } from '~/server/games/daily-challenge/daily-challenge-scoring';

export const JUDGING_ENGINES = {
  LegacyAbsolute: 'legacy-absolute',
  PairwiseLadder: 'pairwise-ladder',
  RollingSwiss: 'rolling-swiss',
} as const;

export type JudgingEngineKey = (typeof JUDGING_ENGINES)[keyof typeof JUDGING_ENGINES];

export const DEFAULT_JUDGING_ENGINE: JudgingEngineKey = JUDGING_ENGINES.LegacyAbsolute;

export function isJudgingEngineKey(value: unknown): value is JudgingEngineKey {
  return Object.values(JUDGING_ENGINES).includes(value as JudgingEngineKey);
}

/**
 * Mod-facing labels. Keyed by the whole union, so adding an engine will not compile until it has
 * one — the alternative is a picker that silently offers a raw key.
 */
export const JUDGING_ENGINE_LABELS: Record<JudgingEngineKey, string> = {
  [JUDGING_ENGINES.LegacyAbsolute]: 'Legacy (absolute scoring)',
  [JUDGING_ENGINES.PairwiseLadder]: 'Pairwise ladder',
  [JUDGING_ENGINES.RollingSwiss]: 'Rolling Swiss (grouped)',
};

export const JUDGING_ENGINE_OPTIONS = Object.values(JUDGING_ENGINES).map((value) => ({
  value,
  label: JUDGING_ENGINE_LABELS[value],
}));

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
   * Whether the caller must hand this engine EVERY eligible entry — several per user — and take
   * one entry per user from the engine's own ranking afterwards, instead of pre-deduping.
   *
   * The default pre-dedupe picks a user's representative by absolute weighted score with a
   * `Math.random()` tiebreak. For an engine that ranks by comparison that puts the coin flip back
   * one level: the ranking would be honest about the 64 representatives, and the choice of WHICH
   * 285 entries those 64 are would still be the mechanism this replaces. Arrival placement already
   * ran on every entry, so the comparisons this needs are ones already paid for and then discarded.
   */
  readonly dedupesAfterRanking: boolean;

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
   * Advance this challenge's ranking by a bounded chunk of work, stopping by `deadlineMs` (an
   * epoch timestamp). Called once per review tick while the challenge is open, after the absolute
   * pass. Returns the model calls actually spent. Optional: an engine that does its work per-entry
   * or at close omits it.
   *
   * This exists because the other two hooks are the only two there were, and between them they
   * force every engine to do its work either one entry at a time or all at once at close. That is
   * not a property of any engine — it is a property of this interface, and it is where the ladder's
   * 28-minute close stage, its expired claim and its concurrent second run all come from. An engine
   * that can do a bounded chunk of work per tick has none of those failures to solve.
   *
   * 🔴 The bound is a DEADLINE, not a call count, and deliberately so. The ladder's per-tick limits
   * were back-solved from a measured 9-second bout, so a slower provider silently invalidated the
   * arithmetic that made them safe. A wall-clock deadline holds whatever the provider does.
   *
   * The engine picks its own entries: it owns its tables, and the caller's ten-minute window
   * decides which entries are sampled INTO the field rather than which are ranked.
   */
  advance?(ctx: JudgingEngineContext, deadlineMs: number): Promise<number>;

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
 * One entry per user, keeping whichever the RANKING put first. Order-preserving, so the result is
 * still the engine's ranking — just thinned.
 *
 * Only meaningful on an already-ranked list: applied to an arbitrary order it picks arbitrarily.
 */
export function bestPerUserInRankOrder<T extends { userId: number }>(ranked: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const entry of ranked) {
    if (seen.has(entry.userId)) continue;
    seen.add(entry.userId);
    out.push(entry);
  }
  return out;
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
