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

const row = (over: Record<string, unknown> = {}) => ({
  modelId: 7,
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

  it('never queries at all for an empty id list', async () => {
    const out = await getActiveSalesForModels([], now);

    expect(out).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
