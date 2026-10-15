/**
 * `User.settings` key for "Hide me from 'who reacted' and 'who collected' lists". The main app writes it; the main
 * app and Creator Studio both filter on it in SQL, so they must read the same string.
 */
export const HIDE_FROM_REACTION_LISTS_KEY = 'hideFromReactionLists';
