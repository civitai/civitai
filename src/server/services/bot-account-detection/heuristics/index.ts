import type { BotAccountHeuristic } from '../scoring';
import { registrationClusterHeuristic } from './clustering';
import { contentTemplatingHeuristic } from './similarity';
import { assetStagingHeuristic } from './staging';
import { postingVelocityHeuristic } from './velocity';

/**
 * The heuristics a production run uses.
 *
 * 🔴 THE PLACEHOLDER IS GONE. `placeholderHeuristic` was labelled "delete it in the change that adds
 * the first real heuristic; it is not a baseline, a prior, or a floor" — this is that change. It is
 * still exported from `scoring.ts` because the registry-mechanics tests need SOMETHING inert to
 * exercise the seam with, but it is not registered and no run scores against it.
 *
 * 🔴 EQUAL WEIGHTS, AND THAT IS A DECISION NOT TO GUESS. Nothing yet distinguishes these four by
 * precision — no run has produced a single graded finding — so any other split would be a number
 * invented to look considered. Equal weights make the blend mean exactly "the average of four
 * independent opinions", which is the only claim the evidence supports today. Re-weighting is what
 * the shadow phase's per-heuristic counters are FOR, and doing it before those counters exist would
 * bake a guess into the thing built to test guesses.
 *
 * 🔴 THAT ARGUMENT WAS RE-EXAMINED WHEN `asset-staging` WAS ADDED RATHER THAN INHERITED, because it
 * arrived with an out-of-band backtest behind it and a stronger signal is the obvious case for a
 * heavier weight. It still gets weight 1, for two reasons that are about the BLEND rather than about
 * the signal. First, a weight is not where strength is expressed here: every heuristic's own number
 * reaches the board as a sub-score, `sole_signal` counts what each one carried alone, and those are
 * the numbers a grading pass reads — a heavier weight would move the blend without telling anyone
 * anything the sub-scores do not already say. Second, the denominator is the whole registry (see
 * `scoreAccount`), so weight is a ZERO-SUM dial: `asset-staging` at weight 2 divides every existing
 * account's confidence by 5 instead of 4, taking a further 20% off three signals that have not been
 * graded either, to express a belief about a fourth that this repository holds no evidence for.
 *
 * 🔴 WHAT ADDING A FOURTH ENTRY DID TO THE OTHER THREE, stated because it is invisible at every
 * call site. The blend divides by the total weight of the whole registry, so going from three equal
 * weights to four multiplies EVERY existing account's confidence by 3/4 — a flat 25% haircut with no
 * heuristic having changed its mind about anything. An account carried by one signal at 0.45 blended
 * to 0.15 and now blends to 0.1125. `MIN_REPORTED_CONFIDENCE` was re-derived in the same change so
 * that the cut keeps meaning what its docstring says it means; had it been left at 0.15, every
 * finding whose confidence sat in [0.15, 0.20) would have dropped off the board silently.
 *
 * 🔴 WHAT THE BLEND STRUCTURALLY CANNOT SAY, stated because a weighted mean invites the opposite
 * reading: with four equal weights, ONE heuristic at full confidence blends to 0.25. So a blend of
 * 0.25 is not "mildly suspicious" — it can be one signal that is completely certain, and the
 * reporting threshold in `scoring.ts` is set against that arithmetic rather than against an
 * intuition about what 0.25 feels like. Read the sub-scores, not the blend; the reason string
 * carries both for that reason.
 *
 * Order is the order a moderator reads them in, cheapest and most self-evident first.
 */
export const BOT_ACCOUNT_HEURISTICS: readonly BotAccountHeuristic[] = [
  postingVelocityHeuristic,
  registrationClusterHeuristic,
  contentTemplatingHeuristic,
  assetStagingHeuristic,
];

export { postingVelocityHeuristic } from './velocity';
export {
  registrationClusterHeuristic,
  registrationClusterGroupKey,
  domainClusterIsNamedInReason,
  isCommonEmailDomain,
  COMMON_EMAIL_DOMAINS,
} from './clustering';
export {
  contentTemplatingHeuristic,
  contentTemplatingSourceScore,
  largestContentCluster,
  CONTENT_TEMPLATING_ID,
} from './similarity';
export {
  assetStagingHeuristic,
  assetStagingHalfScores,
  stagedImageFacts,
  ASSET_STAGING_ID,
  BURST_ONE_AT,
  BURST_ZERO_AT,
  STAGED_ONE_AT,
  STAGED_ZERO_AT,
} from './staging';
export { rampScore } from './ramp';
