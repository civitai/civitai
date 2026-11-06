/**
 * Profanity filtering utilities for API responses
 *
 * This module provides helper functions to filter sensitive profanity data
 * from public API responses while keeping it accessible for moderators/admins.
 */

type ProfanityData = { profanityMatches?: string[]; profanityEvaluation?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Removes the moderator-only profanity fields (`profanityMatches`, `profanityEvaluation`) from a
 * meta/details object unless the requesting user is a moderator.
 */
export function filterSensitiveProfanityData<T extends ProfanityData>(
  obj: T,
  isModerator?: boolean
): T {
  if (isModerator || !isObject(obj)) return obj;
  if (!('profanityMatches' in obj) && !('profanityEvaluation' in obj)) return obj;
  const { profanityMatches: _matches, profanityEvaluation: _evaluation, ...rest } = obj;
  return rest as T;
}

/**
 * A non-moderator's details come from a read that had the profanity fields removed, so a write
 * of them must carry the stored fields forward instead of the client's.
 */
export function keepStoredProfanityData<T extends ProfanityData>(
  incoming: T | undefined,
  stored: unknown
): T | undefined {
  if (!isObject(incoming)) return incoming;
  const rest = filterSensitiveProfanityData(incoming, false);
  if (!isObject(stored)) return rest;
  const kept: ProfanityData = {};
  if (stored.profanityMatches !== undefined)
    kept.profanityMatches = stored.profanityMatches as string[];
  if (stored.profanityEvaluation !== undefined)
    kept.profanityEvaluation = stored.profanityEvaluation;
  return { ...rest, ...kept };
}
