import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * referrals parses `{ ...req.query, ...(req.body ?? {}) }`, so the BODY wins. That
 * precedence is the one place a field fixed on the query-string side can still arrive from
 * somewhere else — an operator sending `confirm: false` in a body to DECLINE a destructive
 * reset must not be overridden by a stale `?confirm=true` in the URL.
 *
 * This drives the real handler. An earlier version of this test asserted
 * `{ ...a, ...b }` against a literal, which is a JS language guarantee and passes happily
 * even when the handler's own spread is reordered — a check that could not fail.
 *
 * WebhookEndpoint is stubbed to the identity so the handler can be called directly; the
 * auth gate is not what is under test here.
 */
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

// eslint-disable-next-line import/first
import referralsHandler from '~/pages/api/testing/referrals';

type Captured = { status?: number; body?: unknown };

function resStub() {
  const captured: Captured = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

async function call(query: Record<string, unknown>, body: Record<string, unknown>) {
  const { res, captured } = resStub();
  await (referralsHandler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'POST', query, body },
    res
  );
  return captured;
}

describe('testing/referrals — the body decides the reset guard, not the query string', () => {
  beforeEach(() => {
    // Only the shape the reset branch reads back. It runs for real in the control below —
    // that is the point: the control has to reach the destructive path to prove the
    // rejection above is about precedence rather than about the guard refusing everything.
    dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    for (const model of [
      'referralReward',
      'referralMilestone',
      'referralRedemption',
      'referralAttribution',
    ] as const) {
      dbMock.dbWrite[model].deleteMany.mockResolvedValue({ count: 0 });
    }
    dbMock.dbWrite.userReferral.updateMany.mockResolvedValue({ count: 0 });
  });

  it('a body `confirm: false` is NOT overridden by `?confirm=true`', async () => {
    const captured = await call(
      { action: 'reset', userId: '1', confirm: 'true' },
      { confirm: false }
    );
    expect(
      captured.status,
      'the query string overrode a body `false` — a declined reset would have run'
    ).toBe(400);
  });

  // Positive control: without it, a handler that rejected every reset would pass above.
  it('a body `confirm: true` is accepted, so the rejection above is about precedence', async () => {
    const captured = await call(
      { action: 'reset', userId: '1', confirm: 'false' },
      { confirm: true }
    );
    expect(captured.status, 'the guard refused an affirmative body value').toBe(200);
  });
});
