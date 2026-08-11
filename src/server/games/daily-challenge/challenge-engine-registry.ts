import { legacyAbsoluteEngine } from '~/server/games/daily-challenge/challenge-engine-legacy';
import { pairwiseLadderEngine } from '~/server/games/daily-challenge/challenge-engine-pairwise';
import {
  DEFAULT_JUDGING_ENGINE,
  isJudgingEngineKey,
  JUDGING_ENGINES,
  type ChallengeJudgingEngine,
  type JudgingEngineContext,
  type JudgingEngineKey,
} from '~/server/games/daily-challenge/challenge-judging-engine';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { FIXED_JUDGING_CATEGORIES } from '~/server/games/daily-challenge/daily-challenge-scoring';
import type { ChallengeJudgingCategory } from '~/server/schema/challenge.schema';

/**
 * Every engine a challenge can be pointed at. Adding one is an entry here plus a value in
 * `JUDGING_ENGINES`; nothing else in the judging path branches on the engine.
 */
export const JUDGING_ENGINE_REGISTRY: Record<JudgingEngineKey, ChallengeJudgingEngine> = {
  [JUDGING_ENGINES.LegacyAbsolute]: legacyAbsoluteEngine,
  [JUDGING_ENGINES.PairwiseLadder]: pairwiseLadderEngine,
};

/**
 * The engine a challenge actually runs on. Anything other than legacy also needs
 * `challenge-pairwise-judging` on, so a bad run can be stopped without editing every row.
 * An unrecognised column value falls back to legacy rather than failing the challenge.
 */
export async function resolveJudgingEngine(
  judgingEngine: string | null | undefined
): Promise<ChallengeJudgingEngine> {
  const key = isJudgingEngineKey(judgingEngine) ? judgingEngine : DEFAULT_JUDGING_ENGINE;
  if (key === DEFAULT_JUDGING_ENGINE) return JUDGING_ENGINE_REGISTRY[key];
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CHALLENGE_PAIRWISE_JUDGING))) {
    return JUDGING_ENGINE_REGISTRY[DEFAULT_JUDGING_ENGINE];
  }
  return JUDGING_ENGINE_REGISTRY[key];
}

/**
 * The rubric an engine judges against: the challenge's own categories and weights when it has
 * them, the fixed daily split otherwise — the same fallback the absolute pass and
 * `getJudgedEntries` use, so an entry is compared on the rubric it was scored against.
 */
export function buildJudgingEngineContext(input: {
  challengeId: number;
  collectionId: number;
  theme: string;
  themeElements?: string[];
  categories?: ChallengeJudgingCategory[];
}): JudgingEngineContext {
  const categories = input.categories?.length
    ? input.categories.map((c) => ({ key: c.key, label: c.label, weight: c.weight }))
    : FIXED_JUDGING_CATEGORIES;
  const criteriaByKey = Object.fromEntries(
    (input.categories ?? []).map((c) => [c.key, c.criteria])
  );
  return {
    challengeId: input.challengeId,
    collectionId: input.collectionId,
    theme: input.theme,
    themeElements: input.themeElements,
    categories,
    criteriaByKey,
  };
}
