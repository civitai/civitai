import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint, bustMinorQueueCounts } = vi.hoisted(() => ({
  callModEndpoint: vi.fn(),
  bustMinorQueueCounts: vi.fn(),
}));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../minor-hash.service', () => ({ bustMinorQueueCounts }));

const { ruleTextScanFlag } = await import('../minor-flag.service');

const reason = { resolvedReason: 'other', internalNotes: 'a cartoon' };

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { ruled: 'lifted' } });
});

describe('ruleTextScanFlag', () => {
  it.each([
    [true, 'Keep flag'],
    [false, 'Lift flag'],
  ])('sends keep=%s with the hash the moderator saw and their reason', async (keep, label) => {
    await ruleTextScanFlag({ modelId: 42, label: 'poi', keep, textHash: 'h-1', reason });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/rule',
      { modelId: 42, label: 'poi', keep, textHash: 'h-1', ...reason },
      label
    );
  });

  it('reports the ruling and refreshes the queue counts', async () => {
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'minor', keep: false, textHash: 'h-1', reason })
    ).toEqual({ ok: true, ruled: 'lifted', label: 'minor', modelId: 42 });
    expect(bustMinorQueueCounts).toHaveBeenCalled();
  });

  it('passes a refusal through without refreshing the counts', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'The text changed since this flag.' });
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'minor', keep: true, textHash: 'h-1', reason })
    ).toEqual({ ok: false, error: 'The text changed since this flag.' });
    expect(bustMinorQueueCounts).not.toHaveBeenCalled();
  });
});
