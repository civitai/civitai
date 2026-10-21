/** Shown on the disabled Delete account button. Never says which hold applies. */
export const LEGAL_HOLD_BUTTON_TEXT = 'Account under legal hold. Contact Legal.';

/** A refused deletion; the same text the main app's endpoint answers with. */
export const LEGAL_HOLD_REFUSAL = 'Account under legal hold; contact Legal.';

export type DeleteButtonState = 'absent' | 'enabled' | 'held';

/** A hold disables the button rather than removing it, and anything but `held === false` is a hold. */
export function deleteButtonState(input: {
  canDelete: boolean;
  deleted: boolean;
  held: boolean | null;
}): DeleteButtonState {
  if (!input.canDelete || input.deleted) return 'absent';
  return input.held === false ? 'enabled' : 'held';
}
