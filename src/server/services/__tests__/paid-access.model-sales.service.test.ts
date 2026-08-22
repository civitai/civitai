import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The card badge runs on a raw $queryRaw that no other suite reaches: the sales-query suite drives the
// Prisma findMany path, and both the service suite and the purchase suite stub the layer above. A review
// found the badge advertising sales up to 14 days before they start, because nothing here could see the
// query's time predicates. This drives the real function and reads the SQL it builds.
// constants and redis/client have canonical mocks registered globally, so this file must not mock them
// itself — a per-file mock of a shared module leaks into other files under --no-isolate. cache-helpers
// is mocked deliberately: running lookupFn is the whole point here, and the canonical fake never calls it.
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

const queryRaw = dbMock.dbRead.$queryRaw;

let nextSaleId = 1;
const row = (over: Record<string, unknown> = {}) => ({
  modelId: 7,
  saleId: nextSaleId++,
  startsAt: new Date('2026-03-01T00:00:00.000Z'),
  endsAt: new Date('2026-03-08T00:00:00.000Z'),
  discountType: 'Percent',
  discountAmount: 25,
  anchorPrice: 1000,
  ...over,
});

const sqlText = () => {
  const call = queryRaw.mock.calls[0][0] as { strings?: string[] } | string[];
  const strings = Array.isArray(call) ? call : call.strings ?? [];
  return strings.join(' ');
};

beforeEach(() => {
  vi.clearAllMocks();
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

  it('badges the DEEPEST overlapping sale, not the one ending soonest', async () => {
    // Overlapping sales are legal (a sale crossing a month boundary meets the next month's) and the page
    // charges the deepest. A card advertising the shallower one under-promises against its own model page.
    queryRaw.mockResolvedValue([
      row({ endsAt: new Date('2026-03-04T00:00:00.000Z'), discountAmount: 10 }),
      row({ endsAt: new Date('2026-03-20T00:00:00.000Z'), discountAmount: 40 }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-20T00:00:00.000Z'),
      discountType: 'Percent',
      discountAmount: 40,
    });
  });

  it('compares a percent against a fixed amount at the price, not against each other', async () => {
    // 20% of 1000 is 200, so the 300 ⚡ sale is deeper despite the smaller-looking number.
    queryRaw.mockResolvedValue([
      row({ discountType: 'Percent', discountAmount: 20 }),
      row({
        endsAt: new Date('2026-03-09T00:00:00.000Z'),
        discountType: 'Fixed',
        discountAmount: 300,
      }),
    ]);

    const out = await getActiveSalesForModels([7], now);

    expect(out[7]).toEqual({
      endsAt: new Date('2026-03-09T00:00:00.000Z'),
      discountType: 'Fixed',
      discountAmount: 300,
    });
  });

  it('badges a running sale even when an unstarted one would sort ahead of it', async () => {
    // The query bounds endsAt only, so a scheduled sale can be the soonest-ending row for the model.
    // Collapsing to it in SQL and then dropping it on the start check left the card with no badge at
    // all while a sale was genuinely running.
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

  it('asks the database for the anchor price the deepest-wins pick needs', async () => {
    await getActiveSalesForModels([7], now);

    const sql = sqlText();
    expect(sql).toContain(`terms->'download'->>'price'`);
    expect(sql).toContain(`terms->'generation'->>'price'`);
    // One row per (model, sale): collapsing in SQL would decide "deepest" before the price is known.
    expect(sql).toContain('GROUP BY mv."modelId", s.id');
  });

  it('never queries at all for an empty id list', async () => {
    const out = await getActiveSalesForModels([], now);

    expect(out).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
