import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint, filterOwnerPendingHolds } = vi.hoisted(() => ({
  callModEndpoint: vi.fn(),
  filterOwnerPendingHolds: vi.fn(),
}));

vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../model-rule-holds.queries', () => ({ filterOwnerPendingHolds }));
vi.mock('../minor-hash.service', () => ({ modelFactsJoin: {} }));
vi.mock('../db', () => ({ dbRead: {} }));

const { decideModelRuleHold, decideOwnerHolds } = await import('../model-rule-holds.service');

beforeEach(() => {
  callModEndpoint.mockReset();
  filterOwnerPendingHolds.mockReset();
});

describe('decideModelRuleHold', () => {
  it('sends the hold, its hash, the decision and the note to the main app’s endpoint', async () => {
    callModEndpoint.mockResolvedValue({
      ok: true,
      body: { holdId: 3, status: 'Dismissed', decision: 'dismiss_allowed', userId: 1 },
    });
    expect(
      await decideModelRuleHold({
        holdId: 3,
        textHash: 'h-3',
        decision: 'dismiss_allowed',
        note: 'fine',
      })
    ).toEqual({ ok: true });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'text-scan/model-rules-hold/resolve',
      { holdId: 3, textHash: 'h-3', decision: 'dismiss_allowed', note: 'fine' },
      'Decide model rule hold'
    );
  });

  it.each([
    ['confirm', 'Confirmed'],
    ['confirm_strike', 'Confirmed'],
    ['dismiss_not_subject', 'Dismissed'],
  ] as const)('accepts %s only when the main app reports %s', async (decision, status) => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { holdId: 3, status } });
    expect(await decideModelRuleHold({ holdId: 3, textHash: 'h', decision })).toEqual({ ok: true });
    callModEndpoint.mockResolvedValue({
      ok: true,
      body: { holdId: 3, status: status === 'Confirmed' ? 'Dismissed' : 'Confirmed' },
    });
    expect(await decideModelRuleHold({ holdId: 3, textHash: 'h', decision })).toMatchObject({
      ok: false,
    });
  });

  it('surfaces a stale or conflicting refusal as the endpoint worded it', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'The text changed since you opened this hold.',
    });
    expect(await decideModelRuleHold({ holdId: 3, textHash: 'h', decision: 'confirm' })).toEqual({
      ok: false,
      error: 'The text changed since you opened this hold.',
    });
  });

  it('warns that the decision may have completed when nobody answered', async () => {
    callModEndpoint.mockResolvedValue({
      ok: false,
      error: 'Decide failed.',
      requestNeverSent: false,
    });
    const result = await decideModelRuleHold({ holdId: 3, textHash: 'h', decision: 'confirm' });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/may already have completed/);
  });
});

describe('decideOwnerHolds', () => {
  it('decides only the owner’s pending holds, in one batch, and reports the rest', async () => {
    filterOwnerPendingHolds.mockResolvedValue([{ id: 4 }, { id: 5 }]);
    callModEndpoint.mockResolvedValue({
      ok: true,
      body: {
        decision: 'confirm',
        results: [
          { holdId: 4, ok: true, status: 'Confirmed' },
          { holdId: 5, ok: false, stale: true, error: 'The text changed.' },
        ],
      },
    });
    const results = await decideOwnerHolds({
      holdId: 3,
      also: [
        { holdId: 4, textHash: 'a' },
        { holdId: 5, textHash: 'b' },
        { holdId: 6, textHash: 'c' },
        { holdId: 3, textHash: 'self' },
      ],
      decision: 'confirm',
      note: 'n',
    });
    expect(callModEndpoint).toHaveBeenCalledWith(
      'text-scan/model-rules-hold/resolve',
      {
        holds: [
          { holdId: 4, textHash: 'a' },
          { holdId: 5, textHash: 'b' },
        ],
        decision: 'confirm',
        note: 'n',
      },
      'Decide model rule holds',
      expect.any(Number)
    );
    expect(results).toEqual([
      { holdId: 4, ok: true },
      { holdId: 5, ok: false, error: 'The text changed.' },
      { holdId: 6, ok: false, error: 'Not a pending hold of the same owner.' },
    ]);
  });

  it('turns a strike into a plain confirm for the other holds', async () => {
    filterOwnerPendingHolds.mockResolvedValue([{ id: 4 }]);
    callModEndpoint.mockResolvedValue({
      ok: true,
      body: { decision: 'confirm', results: [{ holdId: 4, ok: true, status: 'Confirmed' }] },
    });
    await decideOwnerHolds({
      holdId: 3,
      also: [{ holdId: 4, textHash: 'a' }],
      decision: 'confirm_strike',
    });
    expect(callModEndpoint.mock.calls[0][1]).toMatchObject({ decision: 'confirm' });
  });

  it('marks every hold failed when the batch call fails', async () => {
    filterOwnerPendingHolds.mockResolvedValue([{ id: 4 }]);
    callModEndpoint.mockResolvedValue({ ok: false, status: 500, error: 'Boom.' });
    expect(
      await decideOwnerHolds({
        holdId: 3,
        also: [{ holdId: 4, textHash: 'a' }],
        decision: 'confirm',
      })
    ).toEqual([{ holdId: 4, ok: false, error: 'Boom.' }]);
  });
});
