import { dbMock } from '~/__tests__/mocks/db.mock';

type Row = Record<string, any>;
type Where = Record<string, any> | undefined;

const matches = (r: Row, where: Where) =>
  Object.entries(where ?? {}).every(([k, v]) =>
    v && typeof v === 'object' && 'in' in v ? (v.in as unknown[]).includes(r[k]) : r[k] === v
  );

/**
 * An in-memory `creatorProgramPayoutReview` table on `dbMock.dbWrite`, so a hold opened and then
 * released through the real service functions is what the cash-out gate reads. Call `uninstall` in
 * `afterEach`; the db mock is only reset per file.
 */
export function installPayoutReviewTable() {
  const reviews = dbMock.dbWrite.creatorProgramPayoutReview;
  const rows: Row[] = [];
  let nextId = 1;

  reviews.findMany.mockImplementation(async (args?: { where?: Where }) =>
    rows.filter((r) => matches(r, args?.where)).map((r) => structuredClone(r))
  );
  reviews.findUnique.mockImplementation(async ({ where }: { where: Row }) => {
    const key = where.period_userId ?? where;
    const row = rows.find((r) => matches(r, key));
    return row ? structuredClone(row) : null;
  });
  reviews.create.mockImplementation(async ({ data }: { data: Row }) => {
    const row = { id: nextId++, status: 'open', hold: true, version: 1, decisions: [], ...data };
    rows.push(row);
    return structuredClone(row);
  });
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
