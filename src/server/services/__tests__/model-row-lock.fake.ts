import { expect, onTestFinished, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

export const sqlOf = (strings: unknown) =>
  Array.isArray(strings) ? (strings as readonly string[]).join('?') : '';

type Call = (...args: unknown[]) => unknown;

/**
 * A Model row that changes between a read taken before its lock and the read under it: reads answer
 * `asRead` until a `FOR NO KEY UPDATE` locks the row, and the transaction then reads `locked`, the
 * row a flag or lock set in between leaves.
 *
 * `$transaction` hands its callback a client of its own (`tx`), and writes land on `tx.model.update`.
 * While it is open, any query on dbWrite's own connection is refused: Postgres would hold it behind
 * the row lock the transaction has, and the transaction would never commit.
 */
export function rowChangesBeforeLock(asRead: object, locked: object | null) {
  let lockHeld = false;
  let open = false;
  const { dbRead, dbWrite } = dbMock;
  const ownConnection = [
    dbWrite.model.findUnique,
    dbWrite.model.update,
    dbWrite.$queryRaw,
    dbWrite.$executeRaw,
  ];
  // The shared mocks reset per file, not per test: a later test must not inherit this row or lock.
  const mocks = [dbRead.model.findUnique, dbWrite.$transaction, ...ownConnection];
  const previous = mocks.map((mock) => mock.getMockImplementation());
  onTestFinished(() => mocks.forEach((mock, i) => mock.mockImplementation(previous[i] as never)));

  const [, , , ownUpdate, ownQueryRaw, ownExecuteRaw] = previous as (Call | undefined)[];
  const refusedWhileOpen = (mock: (typeof ownConnection)[number], answer: Call) =>
    mock.mockImplementation((async (...args: unknown[]) => {
      if (open) throw new Error('waits on the row lock its own transaction holds');
      return answer(...args);
    }) as never);

  dbRead.model.findUnique.mockResolvedValue(asRead as never);
  refusedWhileOpen(dbWrite.model.findUnique, () => asRead);
  refusedWhileOpen(dbWrite.model.update, (...args) => ownUpdate?.(...args));
  refusedWhileOpen(dbWrite.$queryRaw, (...args) => ownQueryRaw?.(...args) ?? []);
  refusedWhileOpen(dbWrite.$executeRaw, (...args) => ownExecuteRaw?.(...args) ?? 0);

  const tx = {
    $queryRaw: vi.fn(async (strings: unknown) => {
      if (/FOR NO KEY UPDATE/.test(sqlOf(strings))) lockHeld = true;
      return [];
    }),
    $executeRaw: vi.fn<(strings: unknown, ...values: unknown[]) => Promise<number>>(async () => 1),
    model: {
      findUnique: vi.fn(async () => (lockHeld ? locked : asRead)),
      update: vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>(async (args) =>
        ownUpdate?.(args)
      ),
    },
  };
  dbWrite.$transaction.mockImplementation((async (callback: (client: typeof tx) => unknown) => {
    open = true;
    try {
      return await callback(tx);
    } finally {
      open = false;
    }
  }) as never);

  /** What the transaction wrote. */
  const written = () => {
    expect(tx.model.update).toHaveBeenCalledTimes(1);
    return tx.model.update.mock.calls[0][0].data;
  };
  return { tx, written };
}
