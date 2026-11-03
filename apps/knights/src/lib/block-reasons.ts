import { NsfwLevel } from '@civitai/shared';

/** The answer value of the rating question's Blocked option. */
export const BLOCKED_ANSWER = String(NsfwLevel.Blocked);

/** Why a Knight blocks an image: the original game's `NewOrderDamnedReason` names and labels, in its order. */
export const BLOCK_REASONS = [
  { value: 'InappropriateMinors', label: 'Inappropriate Minors' },
  { value: 'RealisticMinors', label: 'Realistic Minors' },
  { value: 'DepictsRealPerson', label: 'Depicts Real Person' },
  { value: 'Bestiality', label: 'Bestiality' },
  { value: 'Other', label: 'Other' },
] as const;

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
