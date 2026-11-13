import { TRPCError } from '@trpc/server';
import { env } from '~/env/server';

/**
 * Whether `error`, thrown by `auditPromptServer`, means the prompt check could not run rather than
 * that it refused the prompt: its retry-able 503 (SERVICE_UNAVAILABLE), thrown when the external
 * classifier is unavailable or when the check's own reads fail. A caller uses it to treat that
 * refusal as our outage (retry, refund, no report) instead of as a block on the user's content.
 *
 * Only meaningful on an error caught directly around `auditPromptServer`. Governed by
 * PROMPT_CHECK_FAIL_CLOSED: with the switch off this is always false, so every caller handles the
 * 503 exactly as it did before the switch existed.
 *
 * Its own module, not an export of `promptAuditing.ts`, because many suites replace that module
 * with a mock that has only `auditPromptServer`.
 */
export function isPromptCheckUnavailable(error: unknown): boolean {
  return (
    env.PROMPT_CHECK_FAIL_CLOSED &&
    error instanceof TRPCError &&
    error.code === 'SERVICE_UNAVAILABLE'
  );
}
