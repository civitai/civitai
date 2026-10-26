/**
 * "Request access" on `/apps/build`. Shared by the form, the tRPC schema and the moderator queue,
 * so the bounds a person types against are the bounds the server enforces.
 */

export const APP_ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export type AppAccessRequestStatus = (typeof APP_ACCESS_REQUEST_STATUSES)[number];

/** The two outcomes a moderator can record. */
export const APP_ACCESS_REQUEST_DECISIONS = ['approved', 'declined'] as const;
export type AppAccessRequestDecision = (typeof APP_ACCESS_REQUEST_DECISIONS)[number];

/** "What do you want to build?" — long enough to say something, short enough to read in a queue. */
export const APP_ACCESS_WHAT_TO_BUILD_MIN = 20;
export const APP_ACCESS_WHAT_TO_BUILD_MAX = 2000;

const HOUR = 60 * 60;
/**
 * A resubmit edits the one pending row, so these bound EDITS as much as requests. Ten an hour
 * leaves room to fix a typo several times; forty a day stops a script.
 */
export const APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS = [
  { limit: 10, period: HOUR },
  { limit: 40, period: 24 * HOUR },
].map((limit) => ({
  ...limit,
  errorMessage: 'You have updated your request a lot. Try again later.',
}));

export const APP_ACCESS_LINKS_MAX = 5;
export const APP_ACCESS_LINK_MAX_LENGTH = 500;

/** Splits the form's one-link-per-line textarea into the list the server takes. */
export function splitAccessRequestLinks(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** An absolute http(s) URL. Moderators open these, so no other scheme is stored. */
export function isAccessRequestLink(value: string): boolean {
  if (value.length > APP_ACCESS_LINK_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
