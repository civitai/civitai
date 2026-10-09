import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

type ClaimRow = {
  transactionId: string;
  userId: number;
  shopItemId: number;
  amount: number;
  status: string;
  attempts: number;
};
type Where = { transactionId: string; status?: string; attempts?: number };
type Data = { status?: string; attempts?: { increment: number } };

const matches = (row: ClaimRow | undefined, where: Where): row is ClaimRow =>
  !!row &&
  (where.status === undefined || row.status === where.status) &&
  (where.attempts === undefined || row.attempts === where.attempts);

/**
 * An in-memory `cosmeticShopPurchaseClaim` delegate with the properties the
 * claim logic relies on: `create` refuses a taken primary key with a real P2002
 * and defaults `attempts` to 1, and `updateMany` / `deleteMany` only touch a row
 * matching every field of their `where`, and report how many. A fake that
 * accepted every write would pass code that never checked a claim's state.
 *
 * `rows` is the table, for seeding a claim an earlier attempt left and for reading
 * the state a purchase ended in. Make a fresh one per test.
 *
 * Writes through `txDelegate` belong to the transaction `rollbackOnThrow` is
 * running and are undone if it throws; writes through `delegate` (the plain
 * client) are not, as in Postgres. The fake takes no row locks: concurrency is
 * simulated by changing `rows` from inside another mock.
 */
export function shopPurchaseClaimFake() {
  const rows = new Map<string, ClaimRow>();
  let journal: (() => void)[] | null = null;

  const makeDelegate = (journaled: boolean) => {
    const remember = (transactionId: string) => {
      if (!journaled || !journal) return;
      const before = rows.get(transactionId);
      const saved = before ? { ...before } : undefined;
      journal.push(() => {
        if (saved) rows.set(transactionId, saved);
        else rows.delete(transactionId);
      });
    };
    const apply = (row: ClaimRow, data: Data) => {
      if (data.status !== undefined) row.status = data.status;
      if (data.attempts) row.attempts += data.attempts.increment;
    };
    return {
      create: async ({ data }: { data: Omit<ClaimRow, 'attempts'> & { attempts?: number } }) => {
        if (rows.has(data.transactionId))
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        remember(data.transactionId);
        const row = { attempts: 1, ...data };
        rows.set(data.transactionId, row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: { transactionId: string } }) => {
        const row = rows.get(where.transactionId);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: { where: { transactionId: string }; data: Data }) => {
        const row = rows.get(where.transactionId);
        if (!row) throw new Error(`shopPurchaseClaimFake: no claim ${where.transactionId}`);
        remember(where.transactionId);
        apply(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Data }) => {
        const row = rows.get(where.transactionId);
        if (!matches(row, where)) return { count: 0 };
        remember(where.transactionId);
        apply(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: { where: Where }) => {
        if (!matches(rows.get(where.transactionId), where)) return { count: 0 };
        remember(where.transactionId);
        rows.delete(where.transactionId);
        return { count: 1 };
      },
    };
  };
  const delegate = makeDelegate(false);
  const txDelegate = makeDelegate(true);

  /**
   * Runs a fake transaction body, undoing the claim writes it made through
   * `txDelegate` if it throws. Without this a claim marked paid inside a grant
   * that then failed would stay paid, which the real database never does.
   */
  const rollbackOnThrow = async <T>(run: () => Promise<T>): Promise<T> => {
    journal = [];
    try {
      return await run();
    } catch (error) {
      journal.reverse().forEach((undo) => undo());
      throw error;
    } finally {
      journal = null;
    }
  };
  return { rows, delegate, txDelegate, rollbackOnThrow };
}

/**
 * A fresh fake, installed as `dbWrite.cosmeticShopPurchaseClaim`. Call it in
 * `beforeEach`; give a hand-built transaction client its `txDelegate`, since the
 * claim is marked paid inside the grant transaction.
 */
export function installShopPurchaseClaimFake() {
  const fake = shopPurchaseClaimFake();
  const target = dbMock.dbWrite.cosmeticShopPurchaseClaim;
  // Fresh call records (and once-queues) per test, so a call count means this test.
  for (const fn of [
    target.create,
    target.findUnique,
    target.update,
    target.updateMany,
    target.deleteMany,
  ])
    fn.mockReset();
  target.create.mockImplementation(fake.delegate.create as never);
  target.findUnique.mockImplementation(fake.delegate.findUnique as never);
  target.update.mockImplementation(fake.delegate.update as never);
  target.updateMany.mockImplementation(fake.delegate.updateMany as never);
  target.deleteMany.mockImplementation(fake.delegate.deleteMany as never);
  return fake;
}
