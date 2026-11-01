import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint } = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../minor-hash.service', () => ({ bustMinorQueueCounts: vi.fn() }));

const { resolveMinorFlagAppeal, resolveMinorFlagAppealPerLabel, resolveRedetection } = await import(
  '../minor-flag.service'
);

const reason = { resolvedReason: 'other', internalNotes: 'a cartoon' };

beforeEach(() => {
  vi.clearAllMocks();
  callModEndpoint.mockResolvedValue({ ok: true, body: { resolved: 'kept' } });
});

describe('resolveRedetection', () => {
  it.each([
    [true, 'Keep re-detected flag'],
    [false, 'Dismiss re-detection'],
  ])('sends keep=%s with the hash the moderator saw and their reason', async (keep, label) => {
    await resolveRedetection(42, 'poi', keep, 'h-1', reason);
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/resolve-redetection',
      { modelId: 42, label: 'poi', keep, textHash: 'h-1', ...reason },
      label
    );
  });

  it('reports what the main app did, including an already-flagged model', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { resolved: 'closed' } });
    expect(await resolveRedetection(42, 'minor', true, 'h-1', reason)).toEqual({
      ok: true,
      resolved: 'closed',
    });
  });

  it('passes a refusal through', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'changed' });
    expect(await resolveRedetection(42, 'minor', true, 'h-1', reason)).toEqual({
      ok: false,
      error: 'changed',
    });
  });
});

describe('appeal rulings', () => {
  beforeEach(() => callModEndpoint.mockResolvedValue({ ok: true, body: { rescanQueued: false } }));

  it('posts the reason with a whole-appeal ruling', async () => {
    await resolveMinorFlagAppeal(42, true, {
      resolvedReason: 'flag-confirmed',
      internalNotes: undefined,
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/resolve-appeal',
      expect.objectContaining({ modelId: 42, uphold: true, resolvedReason: 'flag-confirmed' }),
      'Uphold flag'
    );
  });

  it('posts the reason with a per-label ruling', async () => {
    await resolveMinorFlagAppealPerLabel(42, { minor: 'uphold', poi: 'overturn' }, reason);
    expect(callModEndpoint).toHaveBeenCalledWith(
      'minor-flag/resolve-appeal',
      { modelId: 42, uphold: false, minor: 'uphold', poi: 'overturn', ...reason },
      'Rule per label'
    );
  });
});
