import { TRPCError } from '@trpc/server';

// The orchestrator's refusal of a call that would spend past the Buzz limit on the key that made it:
// a personal API key's own limit, or the cap a user set for an app's offline access. Recognised by the
// response body, never by status alone, so it stays apart from a real insufficient-funds 403 and
// from a scope 403.

export const API_KEY_BUZZ_LIMIT_REACHED =
  'This API key has used its daily Buzz limit. You can change it in Settings > API keys.';
export const OFFLINE_BUZZ_CAP_REACHED =
  "This app has used the Buzz limit you set for it while you're away. You can raise it in Connected apps.";

export type BuzzLimitRefusalSubject = 'apiKey' | 'oauth';

export interface BuzzLimitRefusalPattern {
  status: number;
  subject: BuzzLimitRefusalSubject;
  matches: (body: unknown) => boolean;
}

/**
 * The over-limit responses the orchestrator sends. Empty until the exact response (status, body,
 * detail) is captured on dev, so until then nothing matches and every site maps its errors as before.
 */
export const BUZZ_LIMIT_REFUSALS: readonly BuzzLimitRefusalPattern[] = [];

/** Whose limit refused the call, or null when the response is not a Buzz-limit refusal. */
export function isApiKeyBuzzLimitRefusal(
  status: number | undefined,
  body: unknown,
  patterns: readonly BuzzLimitRefusalPattern[] = BUZZ_LIMIT_REFUSALS
): BuzzLimitRefusalSubject | null {
  if (status == null) return null;
  return patterns.find((p) => p.status === status && p.matches(body))?.subject ?? null;
}

/**
 * Throws FORBIDDEN with a message naming the limit when the response is a Buzz-limit refusal. FORBIDDEN,
 * not TOO_MANY_REQUESTS, even for a 429: waiting does not help until the limit's window rolls over.
 */
export function throwIfApiKeyBuzzLimitRefusal(
  status: number | undefined,
  body: unknown,
  patterns: readonly BuzzLimitRefusalPattern[] = BUZZ_LIMIT_REFUSALS
) {
  const subject = isApiKeyBuzzLimitRefusal(status, body, patterns);
  if (!subject) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: subject === 'oauth' ? OFFLINE_BUZZ_CAP_REACHED : API_KEY_BUZZ_LIMIT_REACHED,
  });
}
