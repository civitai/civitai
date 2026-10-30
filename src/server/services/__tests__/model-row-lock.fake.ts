import { onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

export const sqlOf = (strings: unknown) =>
  Array.isArray(strings) ? (strings as readonly string[]).join('?') : '';

/**
 * A Model row that changes between a read taken before its lock and the read under it: both clients
 * answer `asRead` until a `FOR NO KEY UPDATE` locks the row, and dbWrite then answers `locked`, the
 * row a flag or lock set in between leaves.
 *
 * `$transaction` hands its callback a client of its own (`tx`). While it is open, a raw write on
 * dbWrite's own connection is refused: Postgres would hold it behind the row lock the transaction
 * has, and the transaction would never commit.
 */
export function rowChangesBeforeLock(asRead: object, locked: object) {
  let lockHeld = false;
  let open = false;
  const { dbRead, dbWrite } = dbMock;
  // The shared mocks reset per file, not per test: a later test must not inherit this row or lock.
  const mocks = [
    dbRead.model.findUnique,
    dbWrite.model.findUnique,
    dbWrite.$transaction,
    dbWrite.$executeRaw,
  ];
  const previous = mocks.map((mock) => mock.getMockImplementation());
  onTestFinished(() => mocks.forEach((mock, i) => mock.mockImplementation(previous[i] as never)));

  dbRead.model.findUnique.mockResolvedValue(asRead as never);
  dbWrite.model.findUnique.mockImplementation((async () => (lockHeld ? locked : asRead)) as never);

  const tx = {
    $queryRaw: vi.fn(async (strings: unknown) => {
      if (/FOR NO KEY UPDATE/.test(sqlOf(strings))) lockHeld = true;
      return [];
    }),
    $executeRaw: vi.fn<(strings: unknown, ...values: unknown[]) => Promise<number>>(async () => 1),
    model: dbWrite.model,
  };
  dbWrite.$transaction.mockImplementation((async (callback: (client: typeof tx) => unknown) => {
    open = true;
    try {
      return await callback(tx);
    } finally {
      open = false;
    }
  }) as never);

  const ownConnection = dbWrite.$executeRaw.getMockImplementation();
  dbWrite.$executeRaw.mockImplementation((async (...args: unknown[]) => {
    if (open) throw new Error('waits on the row lock its own transaction holds');
    return ownConnection ? ownConnection(...(args as [never])) : 0;
  }) as never);

  return { tx };
}
