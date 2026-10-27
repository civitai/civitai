/** Shown on the disabled Delete account button. Never says which hold applies. */
export const LEGAL_HOLD_BUTTON_TEXT = 'Account under legal hold. Contact Legal.';

/** A refused deletion; the same text the main app's endpoint answers with. */
export const LEGAL_HOLD_REFUSAL = 'Account under legal hold; contact Legal.';

/** A purge a hold stopped part-way; the same text the main app's endpoint answers with. */
export const LEGAL_HOLD_STOPPED = 'Purge stopped by a legal hold part-way; contact Legal.';

/** The same, when bids it should have refunded were not; the same text the main app answers with. */
export const LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE = `${LEGAL_HOLD_STOPPED} Some bids were not refunded; see the bid-refund-failed alert.`;

export const HOLD_UNKNOWN_BUTTON_TEXT = "Couldn't check legal hold status. Try again.";
export const HOLD_UNKNOWN_REFUSAL = "Couldn't check legal hold status; try again.";

/** `unknown` is any answer other than a plain yes or no, and blocks deletion like a hold. */
export type DeleteHold = 'clear' | 'held' | 'unknown';

export type DeleteButtonState = 'absent' | 'enabled' | 'held' | 'unknown';

/** Anything but `clear` disables the button rather than removing it. */
export function deleteButtonState(input: {
  canDelete: boolean;
  deleted: boolean;
  hold: DeleteHold | null;
}): DeleteButtonState {
  if (!input.canDelete || input.deleted) return 'absent';
  if (input.hold === 'clear') return 'enabled';
  return input.hold === 'held' ? 'held' : 'unknown';
}

/** What a hold-gated button shows; `null` renders nothing. Only `enabled` can be pressed. */
export function holdButtonView(
  state: DeleteButtonState,
  enabledLabel: string
): { label: string; disabled: boolean } | null {
  switch (state) {
    case 'absent':
      return null;
    case 'enabled':
      return { label: enabledLabel, disabled: false };
    case 'held':
      return { label: LEGAL_HOLD_BUTTON_TEXT, disabled: true };
    default:
      return { label: HOLD_UNKNOWN_BUTTON_TEXT, disabled: true };
  }
}

export const deleteButtonView = (state: DeleteButtonState) =>
  holdButtonView(state, 'Delete account');
