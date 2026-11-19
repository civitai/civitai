import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The decide action runs through the REAL `requiresGrant`; the main-app call is stubbed. */
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const { decidePayoutReview } = vi.hoisted(() => ({ decidePayoutReview: vi.fn() }));
vi.mock('$lib/server/user-actions.service', () => ({ decidePayoutReview }));
vi.mock('$lib/server/payout-reviews', () => ({
  listPayoutReviews: vi.fn(),
  lastSettlementAt: vi.fn(),
}));

const { actions } = await import('../+page.server');
const { STALE_REVIEW, UNCONFIRMED_DECISION } = await import('$lib/payout-review');

const GRANTED = { 'creatorProgram.payoutReview.decide': true };
const FIELDS = {
  id: '7',
  userId: '990100034',
  period: '2026-10',
  action: 'withhold',
  version: '3',
  note: '  chargebacks open  ',
  askRef: '   ',
};

const formEvent = (grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return {
    request: { formData: async () => data },
    locals: { user: { id: 990000007 }, grants },
  } as unknown as Parameters<(typeof actions)['decide']>[0];
};

beforeEach(() => vi.clearAllMocks());

describe('decide action', () => {
  it('refuses a moderator without the grant, before calling the main app', async () => {
    const result = await actions.decide(formEvent({ 'user.purge': true }, FIELDS));

    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(decidePayoutReview).not.toHaveBeenCalled();
  });

  it('sends the row as read, with a trimmed note and no blank ask reference', async () => {
    decidePayoutReview.mockResolvedValue({ ok: true, body: { status: 'withheld', version: 4 } });

    const result = await actions.decide(formEvent(GRANTED, FIELDS));

    expect(decidePayoutReview).toHaveBeenCalledWith({
      id: 7,
      userId: 990100034,
      period: '2026-10',
      action: 'withhold',
      version: 3,
      note: 'chargebacks open',
    });
    expect(result).toEqual({ success: true, id: 7 });
  });

  it.each([
    ['an empty note', { note: '   ' }],
    ['no version', { version: '' }],
    ['an action the endpoint does not take', { action: 'release' }],
  ])('refuses %s without calling the main app', async (_, override) => {
    const result = await actions.decide(formEvent(GRANTED, { ...FIELDS, ...override }));

    expect(result).toMatchObject({ status: 400 });
    expect(decidePayoutReview).not.toHaveBeenCalled();
  });

  it('turns a 409 into "changed, reload"', async () => {
    decidePayoutReview.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'Payout review decision: Review 7 changed since version 3; read it again',
      reason: 'Review 7 changed since version 3; read it again',
    });

    const result = await actions.decide(formEvent(GRANTED, FIELDS));

    expect(result).toMatchObject({ status: 409, data: { id: 7, error: STALE_REVIEW } });
  });

  it('does not report a lost response as a refusal', async () => {
    decidePayoutReview.mockResolvedValue({ ok: false, error: 'Payout review decision failed.' });

    const result = await actions.decide(formEvent(GRANTED, FIELDS));

    expect(result).toMatchObject({ status: 502, data: { error: UNCONFIRMED_DECISION } });
  });
});
