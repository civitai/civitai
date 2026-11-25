import { describe, expect, it, vi } from 'vitest';
import { assertAgentReviewAccess } from '~/server/services/blocks/agent-review-lane';

/**
 * The one access gate every agent-review procedure runs. The lane check (a flag read) is passed
 * in, so the gate's own logic is tested without the flag store.
 */
const ONSITE = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const mod = { id: 1, isModerator: true } as never;
const user = { id: 2, isModerator: false } as never;

describe('assertAgentReviewAccess', () => {
  it('a moderator with the request lane enabled passes, asking about THIS request', async () => {
    const lane = vi.fn(async () => true);
    await expect(assertAgentReviewAccess(mod, ONSITE, lane)).resolves.toBeUndefined();
    expect(lane).toHaveBeenCalledWith(ONSITE, { user: mod });
  });

  it.each([
    ['a non-moderator', user],
    ['an anonymous caller', undefined],
  ])('refuses %s before the lane is checked', async (_who, caller) => {
    const lane = vi.fn(async () => true);
    await expect(assertAgentReviewAccess(caller, ONSITE, lane)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Agentic review is restricted to civitai team',
    });
    expect(lane).not.toHaveBeenCalled();
  });

  it("refuses a moderator when the request's lane is disabled", async () => {
    const lane = vi.fn(async () => false);
    await expect(assertAgentReviewAccess(mod, ONSITE, lane)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Agentic review is not enabled',
    });
  });
});
