import { NsfwLevel } from '@civitai/shared';
import { KNIGHTS_BLOCK_REASONS, KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';

/** The answer value of the rating question's Blocked option. */
export const BLOCKED_ANSWER = String(NsfwLevel.Blocked);

/** Whether a question's Blocked answer carries a reason: only the rating question does, as `insertVote` enforces. */
export const asksBlockReason = (questionKey: string | undefined) =>
  questionKey === KNIGHTS_NSFW_LEVEL_QUESTION;

export const BLOCK_REASONS = KNIGHTS_BLOCK_REASONS;

export type BlockReason = (typeof BLOCK_REASONS)[number]['value'];

export const isBlockReason = (value: unknown): value is BlockReason =>
  BLOCK_REASONS.some((reason) => reason.value === value);

/** Whether a rating answer and its reason belong together: Blocked needs one from the list, any other answer carries none. */
export function blockReasonProblem(
  answer: string,
  reason: string | null | undefined
): 'required' | 'invalid' | 'unexpected' | null {
  const given = reason !== null && reason !== undefined && reason !== '';
  if (answer === BLOCKED_ANSWER) {
    if (!given) return 'required';
    return isBlockReason(reason) ? null : 'invalid';
  }
  return given ? 'unexpected' : null;
}
