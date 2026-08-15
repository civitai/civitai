import { hybridNode, registerDefaults, type HybridNode } from './hybrid';

/**
 * Canonical mock for `~/server/db/client`.
 *
 * Registered once, globally, in src/__tests__/setup.ts. Test files must NOT call
 * `vi.mock('~/server/db/client', …)` — see docs/testing/shared-module-mocks.md — they
 * declare behaviour instead:
 *
 *   import { dbMock } from '~/__tests__/mocks/db.mock';
 *   dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['1'] });
 *
 * `dbRead` and `dbWrite` are DISTINCT here. Many hand-written mocks aliased them to one
 * object, which let a `dbWrite` call satisfy a `dbRead` assertion; a file that relied on
 * that has to name the client it actually exercises.
 */

const READ_ROOT = 'dbRead';
const WRITE_ROOT = 'dbWrite';

const emptyArray = () => Promise.resolve([] as unknown[]);
const nullish = () => Promise.resolve(null);
const zero = () => Promise.resolve(0);

/**
 * Post-reset behaviour, keyed on the last path segment. Deliberately conservative: these
 * exist so an unrelated code path reaching an undeclared method gets a plausible empty
 * answer rather than `undefined.map is not a function`. A test that cares about a return
 * value still has to say so.
 */
const DEFAULTS: Record<string, () => Promise<unknown>> = {
  findMany: emptyArray,
  findUnique: nullish,
  findUniqueOrThrow: nullish,
  findFirst: nullish,
  findFirstOrThrow: nullish,
  count: zero,
  aggregate: nullish,
  groupBy: emptyArray,
  $queryRaw: emptyArray,
  $queryRawUnsafe: emptyArray,
  $executeRaw: zero,
  $executeRawUnsafe: zero,
};

registerDefaults((path) => {
  if (!path.startsWith(`${READ_ROOT}.`) && !path.startsWith(`${WRITE_ROOT}.`)) return undefined;

  const segment = path.slice(path.lastIndexOf('.') + 1);

  // `$transaction` runs its callback, because the code under test almost always asserts on
  // what happened INSIDE the transaction. Returning undefined here would make every
  // transactional path a silent no-op — a test that passes because nothing ran.
  if (segment === '$transaction') {
    const client = path.startsWith(`${WRITE_ROOT}.`) ? dbMock.dbWrite : dbMock.dbRead;
    return async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(client);
      if (Array.isArray(arg)) return Promise.all(arg);
      return undefined;
    };
  }

  return DEFAULTS[segment];
});

export const dbMock: { dbRead: HybridNode; dbWrite: HybridNode } = {
  dbRead: hybridNode(READ_ROOT),
  dbWrite: hybridNode(WRITE_ROOT),
};
