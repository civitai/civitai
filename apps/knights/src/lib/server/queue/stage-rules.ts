import type { Rank } from '../ranks';

/**
 * How many votes settle one stage of an item, and how much agreement they need. These are product rules (not
 * detection tuning), so they live here and not in the environment.
 *
 * - `needed`: votes cast at the stage before it can settle.
 * - `max`: votes after which a stage without agreement hands the item up.
 * - `threshold`: the weighted share one answer needs.
 * - `unanimousAtNeeded`: with exactly `needed` votes the answer must be unanimous; `threshold` applies to later votes.
 */
export type StageRule = {
  needed: number;
  max: number;
  threshold: number;
  unanimousAtNeeded?: boolean;
};

export const STAGE_RULES = {
  Knight: { needed: 4, max: 10, threshold: 0.75, unanimousAtNeeded: true },
  Templar: { needed: 3, max: 6, threshold: 0.75, unanimousAtNeeded: true },
  Paladin: { needed: 2, max: 4, threshold: 0.75, unanimousAtNeeded: true },
} as const satisfies Partial<Record<Rank, StageRule>>;

export type RuledStage = keyof typeof STAGE_RULES;

export const isRuledStage = (stage: string): stage is RuledStage => stage in STAGE_RULES;

export type DecisionRule = {
  votesNeeded: number;
  maxVotes: number;
  threshold: number;
  unanimousAtNeeded?: boolean;
};

const ruleAt = (stage: string): StageRule =>
  isRuledStage(stage) ? STAGE_RULES[stage] : STAGE_RULES.Knight;

/**
 * The rule `decideChoice` applies at a stage. An item may ask for fewer votes than the stage needs (its `votesNeeded`),
 * never more, and its question's vote columns are not read: a source cannot set a stricter bar than the product rule.
 */
export const stageDecisionRule = (stage: string, votesNeeded?: number): DecisionRule => {
  const rule = ruleAt(stage);
  return {
    votesNeeded: Math.max(1, Math.min(votesNeeded ?? rule.needed, rule.needed)),
    maxVotes: rule.max,
    threshold: rule.threshold,
    unanimousAtNeeded: 'unanimousAtNeeded' in rule ? rule.unanimousAtNeeded : undefined,
  };
};

/** The votes a stage needs, written on an item arriving at it by escalation. */
export const votesNeededAt = (stage: string): number => ruleAt(stage).needed;
