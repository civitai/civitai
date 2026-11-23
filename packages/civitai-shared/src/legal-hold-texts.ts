/**
 * What a moderator is told when a legal hold or the profile archive refuses an account action. The
 * main app answers with these and the moderator app matches them by equality, so both import them
 * from here. None says which hold applies.
 */

/** A refused deletion or wipe. */
export const LEGAL_HOLD_REFUSAL = 'Account under legal hold; contact Legal.';

/** A wipe a hold stopped part-way. */
export const LEGAL_HOLD_STOPPED = 'Purge stopped by a legal hold part-way; contact Legal.';

/** The same, when bids it should have refunded were not; the moderator must not read it as nothing owed. */
export const LEGAL_HOLD_STOPPED_REFUNDS_INCOMPLETE = `${LEGAL_HOLD_STOPPED} Some bids were not refunded; check the refund alerts.`;

/** Whether a hold applies could not be read; refused like a hold. */
export const HOLD_UNKNOWN_REFUSAL = "Couldn't check legal hold status; try again.";

/** A wipe refused before any delete because its profile archive failed. */
export const PURGE_ARCHIVE_REFUSAL =
  "Purge refused: the profile couldn't be archived, so nothing was deleted. Try again.";
