import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';

export const PROMPT_CHECK_UNAVAILABLE_MESSAGE =
  'The prompt check is temporarily unavailable. Please try again in a moment.';

/**
 * The 503 `auditPromptServer` throws when the prompt check could not run: the external classifier
 * unavailable, or the check's own reads failing. Its own class so a caller can tell it from every
 * other 503, above all the orchestrator submit's own (a submit that may already be queued), which
 * must never be retried as if nothing had been submitted.
 */
export class PromptCheckUnavailableError extends TRPCError {
  constructor(cause?: unknown) {
    super({ code: 'SERVICE_UNAVAILABLE', message: PROMPT_CHECK_UNAVAILABLE_MESSAGE, cause });
  }
}

/**
 * Whether `error` means the prompt check could not run rather than that it refused the prompt. A
 * caller uses it to treat that refusal as our outage (retry, refund, no report) instead of as a
 * block on the user's content. True only for a `PromptCheckUnavailableError`, never for another
 * 503 with the same code.
 *
 * Governed by PROMPT_CHECK_FAIL_CLOSED: with the switch off this is always false, so every caller
 * handles the 503 exactly as it did before the switch existed.
 *
 * Its own module, not an export of `promptAuditing.ts`, because many suites replace that module
 * with a mock that has only `auditPromptServer`.
 */
export function isPromptCheckUnavailable(error: unknown): boolean {
  return env.PROMPT_CHECK_FAIL_CLOSED && error instanceof PromptCheckUnavailableError;
}
