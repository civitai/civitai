/**
 * Profanity filtering utilities for API responses
 *
 * This module provides helper functions to filter sensitive profanity data
 * from public API responses while keeping it accessible for moderators/admins.
 */

/**
 * Removes the moderator-only profanity fields (`profanityMatches`, `profanityEvaluation`) from a
 * meta/details object unless the requesting user is a moderator.
 */
export function filterSensitiveProfanityData<
  T extends { profanityMatches?: string[]; profanityEvaluation?: unknown }
>(obj: T, isModerator?: boolean): T {
  if (isModerator) return obj;
  if (!('profanityMatches' in obj) && !('profanityEvaluation' in obj)) return obj;
  const { profanityMatches: _matches, profanityEvaluation: _evaluation, ...rest } = obj;
  return rest as T;
}
