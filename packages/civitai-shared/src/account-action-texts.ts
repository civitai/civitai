/**
 * What a moderator is told when an account action is refused. The main app answers with these and the
 * moderator app matches them by equality, so both import them from here.
 */

/** A wipe refused before any delete because its profile archive failed. */
export const PURGE_ARCHIVE_REFUSAL =
  "Purge refused: the profile couldn't be archived, so nothing was deleted. Try again.";
