import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOwnerRuleHolds, getModelRuleHoldHistory } = vi.hoisted(() => ({
  getOwnerRuleHolds: vi.fn(),
  getModelRuleHoldHistory: vi.fn(),
}));

vi.mock('$lib/server/model-rule-holds.queries', () => ({
  getOwnerRuleHolds,
  getModelRuleHoldHistory,
}));
vi.mock('$lib/server/api-guard', () => ({
  requireIdParam: (_l: unknown, raw: string) => Number(raw),
}));

const { GET } = await import('../+server');

const get = async () =>
  (
    await GET({ params: { holdId: '12' }, locals: {} } as unknown as Parameters<typeof GET>[0])
  ).json();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('model rule hold context', () => {
  it('returns the owner and the history of the hold', async () => {
    getOwnerRuleHolds.mockResolvedValue({ holds: [1] });
    getModelRuleHoldHistory.mockResolvedValue([{ id: 2 }]);
    expect(await get()).toEqual({ owner: { holds: [1] }, history: [{ id: 2 }] });
    expect(getOwnerRuleHolds).toHaveBeenCalledWith(12);
    expect(getModelRuleHoldHistory).toHaveBeenCalledWith(12);
  });

  it('keeps the history when the owner read fails', async () => {
    getOwnerRuleHolds.mockRejectedValue(new Error('boom'));
    getModelRuleHoldHistory.mockResolvedValue([{ id: 2 }]);
    expect(await get()).toEqual({ owner: null, history: [{ id: 2 }] });
  });

  it('keeps the owner when the history read fails', async () => {
    getOwnerRuleHolds.mockResolvedValue({ holds: [1] });
    getModelRuleHoldHistory.mockRejectedValue(new Error('boom'));
    expect(await get()).toEqual({ owner: { holds: [1] }, history: null });
  });
});
