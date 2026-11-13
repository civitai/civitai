import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import {
  isPromptCheckUnavailable,
  PROMPT_CHECK_UNAVAILABLE_MESSAGE,
  PromptCheckUnavailableError,
} from '~/server/services/orchestrator/prompt-check-unavailable';

/**
 * Only the prompt check's own 503 is "the check could not run". Any other 503, even one with the
 * same code and the same words, is not: the orchestrator submit's 503 may mean the workflow is
 * already queued and charged, and a caller that retried it would submit and charge twice.
 */
describe('isPromptCheckUnavailable', () => {
  beforeEach(() => resetEnv());

  it("is true for the prompt check's 503", () => {
    expect(isPromptCheckUnavailable(new PromptCheckUnavailableError())).toBe(true);
  });

  it('is false for any other 503, even with the same message', () => {
    const lookalike = new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: PROMPT_CHECK_UNAVAILABLE_MESSAGE,
    });
    expect(isPromptCheckUnavailable(lookalike)).toBe(false);
  });

  it('is false with PROMPT_CHECK_FAIL_CLOSED off', () => {
    setEnv({ PROMPT_CHECK_FAIL_CLOSED: false });
    expect(isPromptCheckUnavailable(new PromptCheckUnavailableError())).toBe(false);
  });
});
