import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint, bustMinorQueueCounts } = vi.hoisted(() => ({
  callModEndpoint: vi.fn(),
  bustMinorQueueCounts: vi.fn(),
}));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../minor-hash.service', () => ({ bustMinorQueueCounts }));

const { revertMinorFlag, ruleRestrictedVerdict, ruleTextScanFlag } = await import(
  '../minor-flag.service'
);

const reason = { resolvedReason: 'other', internalNotes: 'a cartoon' };

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { ruled: 'lifted' } });
});

describe('ruleTextScanFlag', () => {
  it('sends the ruling with the hash the moderator saw, reports it and refreshes the queue counts', async () => {
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'minor', keep: false, textHash: 'h-1', reason })
    ).toEqual({ ok: true, ruled: 'lifted', label: 'minor', modelId: 42 });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/rule',
      { modelId: 42, label: 'minor', keep: false, textHash: 'h-1', ...reason },
      'Lift flag'
    );
    expect(bustMinorQueueCounts).toHaveBeenCalled();
  });

  it('reports a keep as kept', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { ruled: 'kept' } });
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'poi', keep: true, textHash: 'h-1', reason })
    ).toMatchObject({ ok: true, ruled: 'kept' });
  });

  // A lift that leaves the model minor must not read as a lift.
  it('reports a lift that left the model minor as keptMinor', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { ruled: 'keptMinor' } });
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'minor', keep: false, textHash: 'h-1', reason })
    ).toMatchObject({ ok: true, ruled: 'keptMinor' });
  });

  it('passes a refusal through without refreshing the counts', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'The text changed since this flag.' });
    expect(
      await ruleTextScanFlag({ modelId: 42, label: 'minor', keep: true, textHash: 'h-1', reason })
    ).toEqual({ ok: false, error: 'The text changed since this flag.' });
    expect(bustMinorQueueCounts).not.toHaveBeenCalled();
  });
});

describe('revertMinorFlag', () => {
  it('reports a revert that left the model minor as such, with a warning', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { reverted: 0, keptMinor: 1, failed: 0 } });
    expect(await revertMinorFlag(42)).toMatchObject({
      ok: true,
      keptMinor: true,
      warning: expect.stringContaining('stays minor'),
    });
  });

  it('control: a plain revert reports success without a warning', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { reverted: 1, keptMinor: 0, failed: 0 } });
    expect(await revertMinorFlag(42)).toEqual({ ok: true });
  });
});

describe('ruleRestrictedVerdict', () => {
  it('sends the time of the lead the moderator saw', async () => {
    await ruleRestrictedVerdict(42, 'dismiss', 'escalated', '2026-11-04T00:00:00.000Z');
    expect(callModEndpoint).toHaveBeenCalledWith(
      'model/resolve-restricted-nsfw-verdict',
      { modelId: 42, ruling: 'dismiss', reason: 'escalated', leadAt: '2026-11-04T00:00:00.000Z' },
      expect.any(String)
    );
  });
});
