import { TRPCError } from '@trpc/server';

// The orchestrator's refusal of a call that would spend past the Buzz limit on the key that made it:
// a personal API key's own limit, or the cap a user set for an app's offline access. The reply is the
// same for both, so whose limit it was comes from the token the call was sent with.

export const API_KEY_BUZZ_LIMIT_REACHED =
  'This API key has used its daily Buzz limit. You can change it in Settings > API keys.';
export const OFFLINE_BUZZ_CAP_REACHED =
  "This app has used the Buzz limit you set for it while you're away. You can raise it in Connected apps.";

/** The ProblemDetails `detail` of the orchestrator's over-limit 402, at submit and at whatif. */
export const BUDGET_EXCEEDED_DETAIL = 'budgetExceeded';

/**
 * Every OAuth access token the auth hub issues starts with this (apps/auth `OAUTH_TOKEN_PREFIX`,
 * which a test keeps equal); a personal API key is bare hex.
 */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'civitai_';

type ProblemDetails = { detail?: unknown; error?: { detail?: unknown } | null };

function problemDetail(body: unknown) {
  if (!body || typeof body !== 'object') return undefined;
  const problem = body as ProblemDetails;
  return problem.detail ?? problem.error?.detail;
}

/**
 * Whether the response is the orchestrator's over-limit refusal. Keyed on status AND detail: a real
 * insufficient-funds reply is a 400 `insufficientBuzz`, and a scope refusal a 403.
 */
export function isBuzzLimitRefusal(status: number | null | undefined, body: unknown) {
  return status === 402 && problemDetail(body) === BUDGET_EXCEEDED_DETAIL;
}

/**
 * Throws FORBIDDEN naming the limit (an app's for an OAuth token, else the key's) when the response
 * is the over-limit refusal; returns otherwise.
 */
export function throwIfApiKeyBuzzLimitRefusal(
  status: number | null | undefined,
  body: unknown,
  token: string
) {
  if (!isBuzzLimitRefusal(status, body)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
      ? OFFLINE_BUZZ_CAP_REACHED
      : API_KEY_BUZZ_LIMIT_REACHED,
  });
}

/** Whether `error` is the FORBIDDEN `throwIfApiKeyBuzzLimitRefusal` threw, so a caller can pass it on as is. */
export function isBuzzLimitRefusalError(error: unknown): error is TRPCError {
  return (
    error instanceof TRPCError &&
    error.code === 'FORBIDDEN' &&
    (error.message === API_KEY_BUZZ_LIMIT_REACHED || error.message === OFFLINE_BUZZ_CAP_REACHED)
  );
}
