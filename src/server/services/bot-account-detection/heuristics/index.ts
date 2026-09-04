import type { BotAccountHeuristic } from '../scoring';
import { registrationClusterHeuristic } from './clustering';
import { contentTemplatingHeuristic } from './similarity';
import { postingVelocityHeuristic } from './velocity';

/**
 * The heuristics a production run uses.
 *
 * 🔴 THE PLACEHOLDER IS GONE. `placeholderHeuristic` was labelled "delete it in the change that adds
 * the first real heuristic; it is not a baseline, a prior, or a floor" — this is that change. It is
 * still exported from `scoring.ts` because the registry-mechanics tests need SOMETHING inert to
 * exercise the seam with, but it is not registered and no run scores against it.
 *
 * 🔴 EQUAL WEIGHTS, AND THAT IS A DECISION NOT TO GUESS. Nothing yet distinguishes these three by
 * precision — no run has produced a single graded finding — so any other split would be a number
 * invented to look considered. Equal weights make the blend mean exactly "the average of three
 * independent opinions", which is the only claim the evidence supports today. Re-weighting is what
 * the shadow phase's per-heuristic counters are FOR, and doing it before those counters exist would
 * bake a guess into the thing built to test guesses.
 *
 * 🔴 WHAT THE BLEND STRUCTURALLY CANNOT SAY, stated because a weighted mean invites the opposite
 * reading: with three equal weights, ONE heuristic at full confidence blends to 0.33. So a blend of
 * 0.33 is not "mildly suspicious" — it can be one signal that is completely certain, and the
 * reporting threshold in `scoring.ts` is set against that arithmetic rather than against an
 * intuition about what 0.33 feels like. Read the sub-scores, not the blend; the reason string
 * carries both for that reason.
 *
 * Order is the order a moderator reads them in, cheapest and most self-evident first.
 */
export const BOT_ACCOUNT_HEURISTICS: readonly BotAccountHeuristic[] = [
  postingVelocityHeuristic,
  registrationClusterHeuristic,
  contentTemplatingHeuristic,
];

export { postingVelocityHeuristic } from './velocity';
export {
  registrationClusterHeuristic,
  isCommonEmailDomain,
  COMMON_EMAIL_DOMAINS,
} from './clustering';
export { contentTemplatingHeuristic } from './similarity';
export { rampScore } from './ramp';
