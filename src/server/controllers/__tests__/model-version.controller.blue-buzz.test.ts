import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wire carries `payWithBlue: boolean`, not a currency, and this handler is where it widens into
 * one. A client naming the currency outright could ask a green-domain purchase to spend yellow, so
 * the domain currency must never come from the request.
 */

const { mockEarlyAccessPurchase } = vi.hoisted(() => ({ mockEarlyAccessPurchase: vi.fn() }));

vi.mock('~/server/services/model-version.service', () => ({
  earlyAccessPurchase: mockEarlyAccessPurchase,
}));
// The controller module reaches the orchestrator caller through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));

import { modelVersionEarlyAccessPurchaseHandler } from '~/server/controllers/model-version.controller';

const call = (payWithBlue: boolean | undefined, isGreen: boolean) =>
  modelVersionEarlyAccessPurchaseHandler({
    input: { modelVersionId: 1, type: 'download', payWithBlue },
    ctx: { user: { id: 99 }, features: { isGreen } },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockEarlyAccessPurchase.mockResolvedValue(true);
});

describe('modelVersionEarlyAccessPurchaseHandler — currency resolution', () => {
  it('charges blue only when the buyer asked for it', async () => {
    await call(true, true);
    expect(mockEarlyAccessPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ buzzType: 'blue', userId: 99 })
    );
  });

  it.each([
    ['green domain', true, 'green'],
    ['red domain', false, 'yellow'],
  ])('falls back to the %s currency without the flag', async (_label, isGreen, expected) => {
    await call(undefined, isGreen);
    expect(mockEarlyAccessPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ buzzType: expected })
    );
  });

  it('does not forward payWithBlue to the service', async () => {
    await call(true, true);
    expect(mockEarlyAccessPurchase.mock.calls[0][0]).not.toHaveProperty('payWithBlue');
  });
});
