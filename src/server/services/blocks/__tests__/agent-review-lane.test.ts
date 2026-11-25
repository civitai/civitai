import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one access gate every agent-review procedure runs. The flag reads are the boundary
 * (Flipt), so they are faked; the gate's own logic is what is tested.
 */
const { mockOnsiteFlag, mockConnectFlag } = vi.hoisted(() => ({
  mockOnsiteFlag: vi.fn(),
  mockConnectFlag: vi.fn(),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAgenticReviewEnabled: mockOnsiteFlag,
  isAppListingsAgenticReviewEnabled: mockConnectFlag,
}));

import { assertAgentReviewAccess } from '~/server/services/blocks/agent-review-lane';

const ONSITE = 'pubreq_0123456789ABCDEFGHJKMNPQRS';
const CONNECT = 'alpr_0123456789ABCDEFGHJKMNPQRS';
const mod = { id: 1, isModerator: true } as never;
const user = { id: 2, isModerator: false } as never;

beforeEach(() => {
  mockOnsiteFlag.mockReset().mockResolvedValue(true);
  mockConnectFlag.mockReset().mockResolvedValue(true);
});

describe('assertAgentReviewAccess', () => {
  it('a moderator with the request lane enabled passes', async () => {
    await expect(assertAgentReviewAccess(mod, ONSITE)).resolves.toBeUndefined();
    expect(mockOnsiteFlag).toHaveBeenCalledWith({ user: mod });
  });

  it.each([
    ['a non-moderator', user],
    ['an anonymous caller', undefined],
  ])('refuses %s before any flag is read', async (_who, caller) => {
    await expect(assertAgentReviewAccess(caller, ONSITE)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Agentic review is restricted to civitai team',
    });
    expect(mockOnsiteFlag).not.toHaveBeenCalled();
    expect(mockConnectFlag).not.toHaveBeenCalled();
  });

  it("refuses a moderator when the request's lane is disabled, and reads THAT lane's flag", async () => {
    // The on-site flag is on: a connect request must still be refused on its own flag.
    mockConnectFlag.mockResolvedValue(false);
    await expect(assertAgentReviewAccess(mod, CONNECT)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Agentic review is not enabled',
    });
    expect(mockOnsiteFlag).not.toHaveBeenCalled();
  });
});
