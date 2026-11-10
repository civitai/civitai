import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMinorFlagAppeal, resolveMinorFlagAppealPerLabel } = vi.hoisted(() => ({
  resolveMinorFlagAppeal: vi.fn(),
  resolveMinorFlagAppealPerLabel: vi.fn(),
}));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../minor-flag.service', () => ({
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
}));

const { ruleFlagAppeal } = await import('../minor-flag-appeal-ruling');

beforeEach(() => {
  vi.clearAllMocks();
  resolveMinorFlagAppeal.mockResolvedValue({ ok: true, rescanQueued: false });
  resolveMinorFlagAppealPerLabel.mockResolvedValue({ ok: true, rescanQueued: true });
});

describe('ruleFlagAppeal', () => {
  it('keeps the flags with an uphold, recording the reason and note', async () => {
    expect(
      await ruleFlagAppeal({
        modelId: 42,
        decision: 'uphold',
        reason: { resolvedReason: 'flag-confirmed', internalNotes: 'uniform' },
      })
    ).toEqual({ ok: true, rescanQueued: false });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledExactlyOnceWith(42, true, {
      resolvedReason: 'flag-confirmed',
      internalNotes: 'uniform',
    });
  });

  it('lifts the flags with an overturn', async () => {
    await ruleFlagAppeal({
      modelId: 42,
      decision: 'overturn',
      reason: { resolvedReason: 'not-a-minor' },
    });
    expect(resolveMinorFlagAppeal).toHaveBeenCalledExactlyOnceWith(42, false, {
      resolvedReason: 'not-a-minor',
      internalNotes: undefined,
    });
  });

  it('rules each label of a split and reports the rescan', async () => {
    expect(
      await ruleFlagAppeal({
        modelId: 42,
        decision: { minor: 'uphold', poi: 'overturn' },
        reason: { resolvedReason: 'not-a-real-person' },
      })
    ).toEqual({ ok: true, rescanQueued: true });
    expect(resolveMinorFlagAppealPerLabel).toHaveBeenCalledExactlyOnceWith(
      42,
      { minor: 'uphold', poi: 'overturn' },
      { resolvedReason: 'not-a-real-person', internalNotes: undefined }
    );
    expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
  });

  it('passes the main app’s refusal through', async () => {
    resolveMinorFlagAppeal.mockResolvedValue({ ok: false, error: 'No open appeal.' });
    expect(
      await ruleFlagAppeal({
        modelId: 42,
        decision: 'uphold',
        reason: { resolvedReason: 'flag-confirmed' },
      })
    ).toEqual({ ok: false, error: 'No open appeal.' });
  });

  it.each([
    ['a missing model id', 0, 'uphold', { resolvedReason: 'flag-confirmed' }, /Missing model id/],
    ['no reason', 42, 'uphold', {}, /Pick a reason/],
    [
      'an unflag reason on an uphold',
      42,
      'uphold',
      { resolvedReason: 'not-a-minor' },
      /not a reason for Rejected/,
    ],
    [
      'a keep reason on an overturn',
      42,
      'overturn',
      { resolvedReason: 'flag-confirmed' },
      /not a reason for Approved/,
    ],
    [
      'a reason for the flag a split keeps',
      42,
      { minor: 'uphold', poi: 'overturn' },
      { resolvedReason: 'not-a-minor' },
      /does not apply to this flag/,
    ],
  ] as const)(
    'refuses %s before calling the main app',
    async (_name, modelId, decision, reason, message) => {
      const res = await ruleFlagAppeal({ modelId, decision, reason });
      expect(res.ok === false && res.error).toMatch(message);
      expect(resolveMinorFlagAppeal).not.toHaveBeenCalled();
      expect(resolveMinorFlagAppealPerLabel).not.toHaveBeenCalled();
    }
  );
});
