/**
 * Profanity filtering utilities for API responses
 *
 * This module provides helper functions to filter sensitive profanity data
 * from public API responses while keeping it accessible for moderators/admins.
 */

/**
 * Filters profanityMatches field from metadata/meta/details objects
 * based on user's moderator status.
 *
 * The profanityMatches field contains explicit profane words detected in content,
 * which should only be visible to moderators for review purposes.
 *
 * @param obj - Object potentially containing profanityMatches field
 * @param isModerator - Whether the requesting user is a moderator
 * @returns Object with profanityMatches removed if user is not a moderator
 *
 * @example
 * const metadata = { title: "Article", profanityMatches: ["badword"] };
 * filterSensitiveProfanityData(metadata, false); // { title: "Article" }
 * filterSensitiveProfanityData(metadata, true);  // { title: "Article", profanityMatches: ["badword"] }
 */
export function filterSensitiveProfanityData<T extends { profanityMatches?: string[] }>(
  obj: T,
  isModerator?: boolean
): T {
  if (isModerator) return obj; // Moderators can see everything
  if (!obj.profanityMatches) return obj; // If no profanityMatches field, return as-is

  // Filter out profanityMatches for non-moderators
  const { profanityMatches, ...rest } = obj;
  return rest as T;
}
