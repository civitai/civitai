/**
 * Forkable apps — the user-facing copy, in one dependency-free module so the server, the client
 * and the tests all read the same strings. Tests pin these WHOLE strings on the rendered page.
 */

/** Page size bounds for the fork list on a parent's store page. */
export const LISTING_FORKS_PAGE_DEFAULT = 12;
export const LISTING_FORKS_PAGE_MAX = 24;

/** The author opt-in checkbox label. */
export const FORK_OPT_IN_LABEL = "Let others fork this app's source";

/**
 * The consent copy under the checkbox. Says forks USUALLY credit the original — not always: a
 * forker who renames the app's blockId before publishing publishes with no "Forked from" credit
 * (a parent can never be forged, only dropped). Also says what a fork does NOT get, and what
 * turning it off does.
 */
export const FORK_OPT_IN_DESCRIPTION =
  "Others can copy your app's source into their own App Assistant workspace and publish it as a new app. " +
  'Published forks usually show “Forked from” with a link back to your app. ' +
  'Forks don’t share your earnings, and a fork has to pass its own review before it can sell anything. ' +
  'Turning this off stops new forks; forks that already exist stay up.';

/** Shown in place of the checkbox while the database migration has not been applied. */
export const FORK_OPT_IN_UNAVAILABLE_NOTE =
  'Forking can’t be turned on here yet. Try again after the next update.';

/** Prefix of the attribution line; the parent's name follows as a link. */
export const FORKED_FROM_PREFIX = 'Forked from ';

/** The attribution line when the parent cannot be shown (hidden, removed or deleted). */
export const FORKED_FROM_UNAVAILABLE = 'Forked from an app that is no longer available';

/** "1 fork" / "N forks". */
export function forkCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'fork' : 'forks'}`;
}

/** The refusal when the opt-in is changed by a caller the rollout flag does not admit. */
export const FORK_SETTING_DISABLED_MESSAGE = 'Forking is not available for your account yet.';
