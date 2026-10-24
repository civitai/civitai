import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubscriptionsService from '~/server/services/subscriptions.service';
import { getCapTier } from '~/server/services/subscriptions.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The card badge runs on a raw $queryRaw that no other suite reaches: the sales-query suite drives the
// Prisma findMany path, and both the service suite and the purchase suite stub the layer above. A review
// found the badge advertising sales up to 14 days before they start, because nothing here could see the
// query's time predicates. This drives the real function and reads the SQL it builds.
// constants and redis/client have canonical mocks registered globally, so this file must not mock them
// itself — a per-file mock of a shared module leaks into other files under --no-isolate. cache-helpers
// is mocked deliberately: running lookupFn is the whole point here, and the canonical fake never calls it.
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsService>()),
  getCapTier: vi.fn(async () => 'gold'),
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: ({
    lookupFn,
  }: {
    lookupFn: (ids: number[]) => Promise<Record<string, unknown>>;
  }) => ({
    fetch: (ids: number[]) => lookupFn(ids),
    bust: vi.fn(),
  }),
}));

import { getActiveSalesForModels } from '~/server/services/paid-access.service';

// The anchor is the capped price, so the owner's tier is an input. Gold is uncapped, which keeps the
// fixtures below about the picker; the free-tier case gets its own test.
const capTier = vi.mocked(getCapTier);

const queryRaw = dbMock.dbRead.$queryRaw;

let nextSaleId = 1;
const row = (over: Record<string, unknown> = {}) => ({
  modelId: 7,
  saleId: nextSaleId++,
  ownerId: 42,
  baseModel: 'SDXL 1.0',
  terms: { download: { price: 1000 } },
  startsAt: new Date('2026-03-01T00:00:00.000Z'),
  endsAt: new Date('2026-03-08T00:00:00.000Z'),
  discountType: 'Percent',
  discountAmount: 25,
  ...over,
});

const sqlText = () => {
  const call = queryRaw.mock.calls[0][0] as { strings?: string[] } | string[];
  const strings = Array.isArray(call) ? call : call.strings ?? [];
  return strings.join(' ');
};

beforeEach(() => {
  vi.clearAllMocks();
  nextSaleId = 1;
  capTier.mockResolvedValue('gold');
  queryRaw.mockResolvedValue([]);
});

describe('getActiveSalesForModels — the card badge', () => {
  const now = new Date('2026-03-02T00:00:00.000Z');

  it('reports a running sale with its discount', async () => {
    queryRaw.mockResolvedValue([row()]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-08T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 25,
    });
  });

  it('does NOT badge a sale that has not started yet', async () => {
    // The badge is model-level and the page is version-level, so a sale advertised before it starts is
    // a card promising a discount the model page and the charge both refuse. Lead time is up to 14 days.
    queryRaw.mockResolvedValue([row({ startsAt: new Date('2026-03-10T00:00:00.000Z') })]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toBeUndefined();
  });

  it('does NOT badge a sale whose window has closed', async () => {
    queryRaw.mockResolvedValue([row({ endsAt: new Date('2026-03-01T12:00:00.000Z') })]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toBeUndefined();
  });

  it('asks the database for the ownership and gate predicates it must not lose', async () => {
    await getActiveSalesForModels([7], now);

    const sql = sqlText();
    // A sale may only price versions its author owns — the create path lives in another application.
    expect(sql).toContain('s."userId" = m."userId"');
    // Sales cover permanent paid access only, never a timed early-access window.
    expect(sql).toContain('pa."timeframeDays" IS NULL');
    expect(sql).toContain(`mv.status = 'Published'`);
    expect(sql).toContain('s."canceledAt" IS NULL');
  });

  // Every fixture below puts the expected winner FIRST. The cache kept the last row per model before
  // this change, so a winner in last position is answered correctly by "keep whatever came last" too.
  it('badges the DEEPEST overlapping sale, not the one ending soonest', async () => {
    // Overlapping sales are legal (a sale crossing a month boundary meets the next month's) and the page
    // charges the deepest. A card advertising the shallower one under-promises against its own page.
    queryRaw.mockResolvedValue([
      row({ endsAt: new Date('2026-03-20T00:00:00.000Z'), discountAmount: 40 }),
      row({ endsAt: new Date('2026-03-04T00:00:00.000Z'), discountAmount: 10 }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-20T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 40,
    });
  });

  it('compares a percent against a fixed amount at the price, not against each other', async () => {
    // 50% of 1000 is 500, so the percent is the deeper of the two while carrying the SMALLER number.
    // Comparing discountAmount alone picks the 300 Buzz sale and is wrong.
    queryRaw.mockResolvedValue([
      row({ discountType: 'Percent', discountAmount: 50 }),
      row({
        endsAt: new Date('2026-03-09T00:00:00.000Z'),
        discountType: 'Fixed',
        discountAmount: 300,
      }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-08T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 50,
    });
  });

  it('measures each sale against the price of the versions IT covers', async () => {
    // Same discount type, so only the anchor separates them: 20% of 1000 is 200 and beats 40% of 100.
    // Dropping anchorPrice from the comparison picks the 40.
    queryRaw.mockResolvedValue([
      row({ endsAt: new Date('2026-03-11T00:00:00.000Z'), discountAmount: 20 }),
      row({ discountAmount: 40, terms: { download: { price: 100 } } }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-11T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 20,
    });
  });

  it('badges nothing when the deepest active sale takes nothing off', async () => {
    // A gate carrying no price: the page applies no discount, so the card must not claim one.
    queryRaw.mockResolvedValue([row({ terms: { download: { price: 0 } } })]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toBeUndefined();
  });

  // The card and the page must resolve "deepest" against the same anchor — the STORED price.
  // 20% of 5000 beats the fixed 300.
  it('anchors on the stored price, and picks the sale the page will charge', async () => {
    capTier.mockResolvedValue(null);
    queryRaw.mockResolvedValue([
      row({ discountType: 'Percent', discountAmount: 20, terms: { download: { price: 5000 } } }),
      row({
        endsAt: new Date('2026-03-09T00:00:00.000Z'),
        discountType: 'Fixed',
        discountAmount: 300,
        terms: { download: { price: 5000 } },
      }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toMatchObject({ discountType: 'Percent', discountAmount: 20 });
  });

  // The owner's tier is not consulted at all any more; the same rows must badge the same way.
  it('badges identically whatever the owner tier', async () => {
    const rows = [
      row({ discountType: 'Percent', discountAmount: 20, terms: { download: { price: 5000 } } }),
    ];
    queryRaw.mockResolvedValue(rows);
    capTier.mockResolvedValue(null);
    const lapsed = await getActiveSalesForModels([7], now);

    queryRaw.mockResolvedValue(rows);
    capTier.mockResolvedValue('gold');
    const gold = await getActiveSalesForModels([7], now);

    expect(lapsed[7]).toEqual(gold[7]);
  });

  it('takes a sale at its dearest covered version, across the rows it spans', async () => {
    // One sale, two covered versions: the 1000 one decides what the sale is worth, not the 100 one.
    queryRaw.mockResolvedValue([
      row({ saleId: 1, discountAmount: 30, terms: { download: { price: 100 } } }),
      row({ saleId: 1, discountAmount: 30, terms: { download: { price: 1000 } } }),
      row({ saleId: 2, endsAt: new Date('2026-03-14T00:00:00.000Z'), discountAmount: 25 }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    // 30% of 1000 beats 25% of 1000; anchoring sale 1 on its cheapest version would flip it.
    expect(out[7]?.discountAmount).toBe(30);
  });

  it('badges a running sale even when an unstarted one is deeper', async () => {
    // Lead time is up to 14 days and the query bounds endsAt only, so a scheduled sale reaches this
    // function. It must lose to a running one however deep it is, and must not blank the badge.
    queryRaw.mockResolvedValue([
      row({
        startsAt: new Date('2026-03-05T00:00:00.000Z'),
        endsAt: new Date('2026-03-06T00:00:00.000Z'),
        discountAmount: 50,
      }),
      row({ discountAmount: 15 }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-08T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 15,
    });
  });

  it('keeps each model to its own sales when several are batched', async () => {
    queryRaw.mockResolvedValue([
      row({ discountAmount: 15 }),
      row({ modelId: 9, endsAt: new Date('2026-03-12T00:00:00.000Z'), discountAmount: 35 }),
    ]);

    const out = await getActiveSalesForModels([7, 9], now);

    expect(out[7]?.discountAmount).toBe(15);
    expect(out[9]?.discountAmount).toBe(35);
  });

  it('asks the database for the raw terms the anchor is computed from', async () => {
    await getActiveSalesForModels([7], now);

    const sql = sqlText();
    // Prices come back as raw terms and are read in JS: a jsonb `::int` hard-errors the whole batch on
    // a fractional price, which nothing at the write boundary rejects.
    expect(sql).toContain('pa.terms AS "terms"');
    expect(sql).toContain('m."userId" AS "ownerId"');
    expect(sql).not.toContain('::int');
    // Collapsing per model in SQL decides "deepest" before the price is known - the bug this replaced.
    expect(sql).not.toContain('DISTINCT ON');
  });

  it('never queries at all for an empty id list', async () => {
    const out = await getActiveSalesForModels([], now);

    expect(out).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
