import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint, bustMinorQueueCounts } = vi.hoisted(() => ({
  callModEndpoint: vi.fn(),
  bustMinorQueueCounts: vi.fn(),
}));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../minor-hash.service', () => ({ bustMinorQueueCounts }));

const { confirmPoiFlag, dismissPoiHashMatch, revertPoiFlag, setModelPoiFlag } = await import(
  '../minor-flag.service'
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the real-person hash endpoints', () => {
  it.each([
    ['confirm', confirmPoiFlag, 'poi-flag/confirm', 'confirmed'],
    ['revert', revertPoiFlag, 'poi-flag/revert', 'reverted'],
    ['dismiss', dismissPoiHashMatch, 'poi-flag/dismiss', 'dismissed'],
    ['flag', setModelPoiFlag, 'poi-flag/flag-match', 'flagged'],
  ] as const)('%s reports a 200 that acted on nothing as a failure', async (_, call, path, key) => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { [key]: 0 } });
    expect(await call(42)).toMatchObject({ ok: false, error: expect.stringMatching(/^Nothing/) });
    expect(callModEndpoint).toHaveBeenCalledWith(path, { modelId: 42 }, expect.any(String));
    expect(bustMinorQueueCounts).not.toHaveBeenCalled();

    callModEndpoint.mockResolvedValue({ ok: true, body: { [key]: 1 } });
    expect(await call(42)).toEqual({ ok: true });
    expect(bustMinorQueueCounts).toHaveBeenCalled();
  });

  it('passes a refused call through without refreshing the counts', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'Forbidden.' });
    expect(await confirmPoiFlag(42)).toEqual({ ok: false, error: 'Forbidden.' });
    expect(bustMinorQueueCounts).not.toHaveBeenCalled();
  });
});
