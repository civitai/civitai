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
 * The consent copy under the checkbox. Plain about the one thing that cannot be undone: a fork's
 * "Forked from" credit stays. Also says what a fork does NOT get, and what turning it off does.
 */
export const FORK_OPT_IN_DESCRIPTION =
  "Others can copy your app's source into their own App Assistant workspace and publish it as a new app. " +
  'Every published fork shows “Forked from” with a link to your app, and that credit can’t be removed. ' +
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

// ---------------------------------------------------------------------------
// The Fork action (PR 3): `appListings.startFork` and the App Assistant page.
// ---------------------------------------------------------------------------

/** The Fork action's label, on the store page and in the running app's ⋮ menu. */
export const FORK_ACTION_LABEL = 'Fork';

/** Per-user caps on starting a fork. Each start builds and uploads a copy of the parent's source. */
export const FORK_START_LIMITS = [
  { windowSeconds: 60 * 60, max: 5 },
  { windowSeconds: 24 * 60 * 60, max: 20 },
] as const;

/** Refusals of `appListings.startFork`, pinned whole by the tests. */
export const FORK_PARENT_UNAVAILABLE_MESSAGE = 'This app isn’t available to fork.';
export const FORK_NOT_ALLOWED_MESSAGE = 'The author of this app hasn’t allowed forks.';
export const FORK_NO_APPROVED_VERSION_MESSAGE = 'This app has no reviewed version to fork yet.';
export const FORK_RATE_LIMITED_MESSAGE =
  'You can start up to 5 forks an hour and 20 a day. Try again later.';
export const FORK_UNAVAILABLE_HERE_MESSAGE = 'Forking isn’t available on this site yet.';
export const FORK_TOO_LARGE_MESSAGE = 'This app is too large to fork.';
export const FORK_BUSY_MESSAGE = 'Forking is busy right now. Try again in a moment.';
export const FORK_SOURCE_UNREADABLE_MESSAGE = 'This app’s source couldn’t be prepared for forking.';

/** The App Assistant page's query parameter naming the fork to set up. */
export const FORK_QUERY_PARAM = 'fork';

/** The empty-chat card on a fresh fork. `{parent}` is the parent app's store name. */
export function forkSetupPrompt(parentName: string): string {
  return `Forked from ${parentName}. Set it up and preview?`;
}
export const FORK_SETUP_BUTTON = 'Set up';
/** The one message Set up sends, as the user's, once. */
export const FORK_SETUP_MESSAGE =
  'Set up this forked app: install its dependencies, start the dev server and check the preview.';

/** Shown while the forked app is being created. */
export const FORK_CREATING_MESSAGE = 'Copying the app into your workspace…';

/**
 * What the App Assistant page shows when the sandbox service refuses a seeded create, by the
 * service's `code`. Written for the user: no service wording.
 */
export const FORK_SEED_ERROR_MESSAGES = {
  seed_host_not_allowed: 'Forking isn’t available right now. Try again later.',
  seed_too_large: 'This app is too large to fork.',
  seed_hash_mismatch: 'The app’s files didn’t arrive intact. Try again.',
  seed_rejected_entry: 'This app’s files couldn’t be copied into your workspace.',
  seed_fetch_failed: 'The app’s files couldn’t be downloaded. Try again.',
  seed_busy: 'Forking is busy right now. Try again in a moment.',
  seed_lost: 'Your fork’s files never arrived, so this app is empty.',
} as const;
export type ForkSeedErrorCode = keyof typeof FORK_SEED_ERROR_MESSAGES;

/** Seed errors a fresh fork cannot fix: no Try again. */
export const FORK_SEED_ERRORS_WITHOUT_RETRY: readonly ForkSeedErrorCode[] = [
  'seed_too_large',
  'seed_rejected_entry',
];

/** Any other failure to create the forked app. */
export const FORK_CREATE_FAILED_MESSAGE = 'Your fork couldn’t be created. Try again.';
/** The fork named in the address is not this user's, or has expired. */
export const FORK_SESSION_MISSING_MESSAGE =
  'This fork has expired. Fork the app again from its page.';
export const FORK_TRY_AGAIN_LABEL = 'Try again';
