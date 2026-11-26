import { decideChoice } from '../queue/resolution';
import { stageDecisionRule } from '../queue/stage-rules';
import { YESNO_ANSWERS } from './keys';

export type YesNoDecision =
  | { kind: 'pending' }
  | { kind: 'consensus'; value: 'yes' | 'no' }
  | { kind: 'exhausted' };

const offered = new Set<string>(YESNO_ANSWERS.map((a) => a.value));

/**
 * A stage decides a question by the rating stage rule (`STAGE_RULES`): unanimous at the votes the stage needs, then 75% up to its
 * cap. A stage that reaches the cap without that agreement is exhausted, and the caller hands the question up. One vote per
 * person, as the label store counts them; an answer of weight 0 (a held player's) is recorded but is not a vote here.
 */
export function decideYesNo(
  cast: { answer: string; weight: number }[],
  stage: string,
  {
    noSettlesAtNeeded = true,
  }: {
    /** False for a "no" that needs more than the minimum: at exactly the stage's needed votes it stays pending. */
    noSettlesAtNeeded?: boolean;
  } = {}
): YesNoDecision {
  const votes = counted(cast);
  const decision = decideChoice(votes, stageDecisionRule(stage));
  if (decision.kind === 'resolved') {
    if (!noSettlesAtNeeded && decision.value === 'no' && settledAtNeeded(cast, stage))
      return { kind: 'pending' };
    return { kind: 'consensus', value: decision.value as 'yes' | 'no' };
  }
  return decision.kind === 'split' ? { kind: 'exhausted' } : { kind: 'pending' };
}

const counted = (cast: { answer: string; weight: number }[]) =>
  cast
    .filter((v) => v.weight > 0 && offered.has(v.answer))
    .map((v) => ({ answer: v.answer, weight: 1 }));

/** Whether the stage's counted answers are exactly the votes it needs: a consensus there was reached on the minimum. */
export const settledAtNeeded = (cast: { answer: string; weight: number }[], stage: string) =>
  counted(cast).length === stageDecisionRule(stage).votesNeeded;
