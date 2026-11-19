/**
 * Profanity filtering utilities for API responses
 *
 * This module provides helper functions to filter sensitive profanity data
 * from public API responses while keeping it accessible for moderators/admins.
 */

type ProfanityData = { profanityMatches?: string[]; profanityEvaluation?: unknown };

/** The moderator-only profanity fields, hidden from and refused from everyone else. */
export const PROFANITY_META_KEYS = ['profanityMatches', 'profanityEvaluation'] as const;

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
  if (!PROFANITY_META_KEYS.some((key) => key in obj)) return obj;
  const rest: Record<string, unknown> = { ...obj };
  for (const key of PROFANITY_META_KEYS) delete rest[key];
  return rest as T;
}

/**
 * A non-moderator's details come from a read that had the profanity fields removed, so a write of
 * them keeps the stored fields, unless the write carries a fresh detection of its own.
 */
export function keepStoredProfanityData<T extends ProfanityData>(
  incoming: T | null | undefined,
  stored: unknown
): T | null | undefined {
  if (!isObject(stored)) return incoming;
  const kept: ProfanityData = {};
  if (stored.profanityMatches !== undefined)
    kept.profanityMatches = stored.profanityMatches as string[];
  if (stored.profanityEvaluation !== undefined)
    kept.profanityEvaluation = stored.profanityEvaluation;
  if (!Object.keys(kept).length) return incoming;
  if (!isObject(incoming)) return kept as T;
  if ('profanityMatches' in incoming || 'profanityEvaluation' in incoming) return incoming;
  return { ...incoming, ...kept };
}
