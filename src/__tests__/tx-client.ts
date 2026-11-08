import { onTestFinished, type Mock } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The shared db mock hands every transaction callback `dbWrite` itself, so a write made through the
 * transaction client and one made on `dbWrite` directly (outside the transaction, in Postgres) look
 * the same. `useTxClients` gives each transaction its own client instead: a proxy over `dbWrite`
 * that numbers the calls made through it. `recordTx` notes, for one mock, the number of the
 * transaction each of its calls went through, 0 for a call made on `dbWrite` itself.
 */
let txSeq = 0;
let via = 0;

const through =
  (id: number, fn: (...args: unknown[]) => unknown) =>
  (...args: unknown[]) => {
    const outer = via;
    via = id;
    try {
      return fn(...args);
    } finally {
      via = outer;
    }
  };

const txClient = (id: number) =>
  new Proxy(dbMock.dbWrite as object, {
    get(target, prop) {
      const member = Reflect.get(target, prop);
      // A symbol (pretty-format printing the client) or a non-object passes through as it is.
      if (typeof prop !== 'string' || (typeof member !== 'object' && typeof member !== 'function'))
        return member;
      if (prop.startsWith('$')) return through(id, member);
      return new Proxy(member, {
        get: (model, method) => {
          const fn = Reflect.get(model, method);
          return typeof fn === 'function' ? through(id, fn) : fn;
        },
      });
    },
  });

// The shared mocks are reset per file, not per test: put back what this replaced when the test ends.
function replaceImplementation(fn: Mock, impl: (...args: never[]) => unknown) {
  const previous = fn.getMockImplementation();
  fn.mockImplementation(impl as never);
  onTestFinished(() => {
    fn.mockImplementation(previous ?? (() => undefined));
  });
}

/** Every `dbWrite.$transaction` callback in this test gets its own numbered client. */
export function useTxClients() {
  replaceImplementation(
    dbMock.dbWrite.$transaction as Mock,
    (async (arg: unknown) => {
      if (typeof arg !== 'function') return Promise.all(arg as unknown[]);
      return arg(txClient(++txSeq));
    }) as never
  );
}

/** For the rest of this test, `fn` resolves to `result` and records the transaction of each call. */
export function recordTx(fn: unknown, result: unknown) {
  const ranIn: number[] = [];
  replaceImplementation(fn as Mock, async () => {
    ranIn.push(via);
    return result;
  });
  return ranIn;
}
