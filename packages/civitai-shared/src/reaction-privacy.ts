/**
 * `User.settings` key for "Hide me from 'who reacted' and 'who collected' lists". The main app writes it; the main
 * app and Creator Studio both filter on it in SQL, so they must read the same string.
 */
export const HIDE_FROM_REACTION_LISTS_KEY = 'hideFromReactionLists';

/**
 * `User.settings` key for "Show my older image reactions in 'who reacted' lists". An image reaction made before those
 * lists launched is left out of them unless its reactor turned this on. The partial index on `"User"` that serves the
 * lookup names this key literally, so changing it means a new index.
 */
export const SHOW_PRE_LAUNCH_REACTIONS_KEY = 'showPreLaunchReactions';

/**
 * When image "who reacted" lists went live (UTC, compared against `ImageReaction."createdAt"`, a timestamp without
 * time zone written in UTC). Reactions before it were made when no list named reactors.
 */
export const IMAGE_REACTOR_LISTS_LAUNCHED_AT = '2026-09-23 17:07:40';
