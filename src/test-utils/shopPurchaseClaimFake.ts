import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

type ClaimRow = {
  transactionId: string;
  userId: number;
  shopItemId: number;
  amount: number;
  status: string;
};
type Where = { transactionId: string; status?: string };

const matches = (row: ClaimRow | undefined, where: Where) =>
  !!row && (where.status === undefined || row.status === where.status);

/**
 * An in-memory `cosmeticShopPurchaseClaim` delegate with the two properties the
 * claim logic relies on: `create` refuses a taken primary key with a real P2002,
 * and `updateMany` / `deleteMany` only touch rows whose status matches, and report
 * how many. A fake that accepted every write would pass code that never checked
 * a claim's status.
 *
 * `rows` is the table, for seeding a claim an earlier attempt left and for reading
 * the status a purchase ended in. Make a fresh one per test.
 */
export function shopPurchaseClaimFake() {
  const rows = new Map<string, ClaimRow>();
  const delegate = {
    create: async ({ data }: { data: ClaimRow }) => {
      if (rows.has(data.transactionId))
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      rows.set(data.transactionId, { ...data });
      return { ...data };
    },
    findUnique: async ({ where }: { where: { transactionId: string } }) => {
      const row = rows.get(where.transactionId);
      return row ? { ...row } : null;
    },
    update: async ({
      where,
      data,
    }: {
      where: { transactionId: string };
      data: { status: string };
    }) => {
      const row = rows.get(where.transactionId);
      if (!row) throw new Error(`shopPurchaseClaimFake: no claim ${where.transactionId}`);
      row.status = data.status;
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Where; data: { status: string } }) => {
      const row = rows.get(where.transactionId);
      if (!row || !matches(row, where)) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    },
    deleteMany: async ({ where }: { where: Where }) => {
      if (!matches(rows.get(where.transactionId), where)) return { count: 0 };
      rows.delete(where.transactionId);
      return { count: 1 };
    },
  };
  /**
   * Runs a fake transaction body, restoring the claims if it throws. Without
   * this a claim marked paid inside a grant that then failed would stay paid,
   * which the real database never does.
   */
  const rollbackOnThrow = async <T>(run: () => Promise<T>): Promise<T> => {
    const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }]));
    try {
      return await run();
    } catch (error) {
      rows.clear();
      snapshot.forEach((v, k) => rows.set(k, v));
      throw error;
    }
  };
  return { rows, delegate, rollbackOnThrow };
}

/**
 * A fresh fake, installed as `dbWrite.cosmeticShopPurchaseClaim`. Call it in
 * `beforeEach`; pass `delegate` to any hand-built transaction client too, since
 * the claim is marked paid inside the grant transaction.
 */
export function installShopPurchaseClaimFake() {
  const fake = shopPurchaseClaimFake();
  const target = dbMock.dbWrite.cosmeticShopPurchaseClaim;
  target.create.mockImplementation(fake.delegate.create as never);
  target.findUnique.mockImplementation(fake.delegate.findUnique as never);
  target.update.mockImplementation(fake.delegate.update as never);
  target.updateMany.mockImplementation(fake.delegate.updateMany as never);
  target.deleteMany.mockImplementation(fake.delegate.deleteMany as never);
  return fake;
}
