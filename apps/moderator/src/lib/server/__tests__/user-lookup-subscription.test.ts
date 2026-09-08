import { describe, expect, it, vi } from 'vitest';

/**
 * Which CustomerSubscription row the User Lookup panel speaks for when a user holds several.
 *
 * The bug this guards: `getSubscription` returned the hardcoded `yellow` row regardless of status, so a
 * `canceled` paid row hid an `active` buzz-bought one and the moderator read "no membership" for a user
 * who has one. The rows are canned and the selection runs in JS, so these assert the ordering itself —
 * the whole behaviour — not the SQL.
 */

const rows = vi.hoisted(() => [] as unknown[]);

vi.mock('$lib/server/db', () => {
  // Fluent builder ending in `.execute()`, which resolves whatever the current test staged in `rows`.
  const builder: Record<string, unknown> = {};
  for (const method of ['selectFrom', 'leftJoin', 'select', 'where', 'orderBy']) {
    builder[method] = () => builder;
  }
  builder.execute = async () => rows;
  return { dbRead: builder, dbWrite: builder };
});

const { getSubscription } = await import('../user-lookup.service');

const NOW = new Date('2026-09-07T00:00:00Z');
const future = new Date('2026-09-26T00:00:00Z');
const past = new Date('2026-07-25T00:00:00Z');

const row = (over: Record<string, unknown>) => ({
  productName: null,
  provider: null,
  status: 'active',
  buzzType: 'yellow',
  cancelAtPeriodEnd: null,
  canceledAt: null,
  currentPeriodEnd: future,
  interval: null,
  unitAmount: null,
  currency: null,
  ...over,
});

const stage = (next: unknown[]) => {
  rows.length = 0;
  rows.push(...next);
};

describe('user lookup — which subscription row the panel shows', () => {
  it('returns null when the user has no subscription rows', async () => {
    stage([]);
    expect(await getSubscription(1, NOW)).toBeNull();
  });

  it('prefers an active buzz-bought row over a canceled paid row (the reported repro)', async () => {
    stage([
      row({ buzzType: 'yellow', status: 'canceled', currentPeriodEnd: past }),
      row({ buzzType: 'buzzPurchase', status: 'active', currentPeriodEnd: future }),
    ]);
    const picked = await getSubscription(309009, NOW);
    expect(picked?.buzzType).toBe('buzzPurchase');
  });

  it('keeps a live paid row ahead of a longer-dated referral grant (the original guard)', async () => {
    const later = new Date('2027-01-01T00:00:00Z');
    stage([
      row({ buzzType: 'referral', status: 'active', currentPeriodEnd: later }),
      row({ buzzType: 'yellow', status: 'active', currentPeriodEnd: future }),
    ]);
    const picked = await getSubscription(1, NOW);
    expect(picked?.buzzType).toBe('yellow');
  });

  it('falls back to a lapsed paid row when nothing is live', async () => {
    stage([
      row({ buzzType: 'yellow', status: 'canceled', currentPeriodEnd: past }),
      row({ buzzType: 'referral', status: 'canceled', currentPeriodEnd: past }),
    ]);
    const picked = await getSubscription(1, NOW);
    expect(picked?.buzzType).toBe('yellow');
  });

  it('does not let a past_due paid row hide an active variant', async () => {
    stage([
      row({ buzzType: 'yellow', status: 'past_due', currentPeriodEnd: future }),
      row({ buzzType: 'buzzPurchase', status: 'active', currentPeriodEnd: future }),
    ]);
    const picked = await getSubscription(1, NOW);
    expect(picked?.buzzType).toBe('buzzPurchase');
  });

  it('still shows a past_due paid row when it is the only one', async () => {
    stage([row({ buzzType: 'yellow', status: 'past_due', currentPeriodEnd: future })]);
    const picked = await getSubscription(1, NOW);
    expect(picked?.buzzType).toBe('yellow');
  });

  it('treats a period-ended row as not live even when status is still active', async () => {
    stage([
      row({ buzzType: 'yellow', status: 'active', currentPeriodEnd: past }),
      row({ buzzType: 'buzzPurchase', status: 'active', currentPeriodEnd: future }),
    ]);
    const picked = await getSubscription(1, NOW);
    expect(picked?.buzzType).toBe('buzzPurchase');
  });
});
