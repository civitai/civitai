import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

type Row = Record<string, any>;
type Where = Record<string, any> | undefined;

const matches = (r: Row, where: Where) =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v === null || typeof v !== 'object') return r[k] === v;
    if (Object.keys(v).length === 1 && 'in' in v) return (v.in as unknown[]).includes(r[k]);
    throw new Error(`payout-review fake: unsupported filter on ${k}: ${JSON.stringify(v)}`);
  });

const project = (r: Row, select?: Record<string, boolean>) =>
  structuredClone(select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : r);

/**
 * An in-memory `creatorProgramPayoutReview` table on `dbMock.dbWrite`, so a hold opened and then
 * released through the real service functions is what the cash-out gate reads. Call `uninstall` in
 * `afterEach`; the db mock is only reset per file.
 */
export function installPayoutReviewTable() {
  const reviews = dbMock.dbWrite.creatorProgramPayoutReview;
  const rows: Row[] = [];
  let nextId = 1;

  reviews.findMany.mockImplementation(
    async (args?: { where?: Where; select?: Record<string, boolean> }) =>
      rows.filter((r) => matches(r, args?.where)).map((r) => project(r, args?.select))
  );
  reviews.findUnique.mockImplementation(
    async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
      const row = rows.find((r) => matches(r, where.period_userId ?? where));
      return row ? project(row, select) : null;
    }
  );
  reviews.create.mockImplementation(
    async ({ data, select }: { data: Row; select?: Record<string, boolean> }) => {
      if (rows.some((r) => r.period === data.period && r.userId === data.userId))
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      const row = { id: nextId++, status: 'open', hold: true, version: 1, decisions: [], ...data };
      rows.push(row);
      return project(row, select);
    }
  );
  reviews.updateMany.mockImplementation(async ({ where, data }: { where: Where; data: Row }) => {
    const hit = rows.filter((r) => matches(r, where));
    for (const r of hit)
      for (const [k, v] of Object.entries(data))
        r[k] = v && typeof v === 'object' && 'increment' in v ? r[k] + v.increment : v;
    return { count: hit.length };
  });

  return {
    rows,
    uninstall: () => {
      reviews.findMany.mockReset().mockResolvedValue([]);
      reviews.findUnique.mockReset().mockResolvedValue(null);
      reviews.create.mockReset();
      reviews.updateMany.mockReset();
    },
  };
}
