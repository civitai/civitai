// Setup-order import: installs the shared mocks (logging among them) before the store loads.
import '~/__tests__/setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { DocStoreClient, DocStoreDb } from '~/server/services/apps/doc-store';
import { createDocStore } from '~/server/services/apps/doc-store';
import type { DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import { PREFS } from './doc-store.functional';

// The store reached a database it could not use: the pool could not hand out a connection, or
// the connection broke under the transaction. Those are availability faults — a retryable 503
// `service_unavailable` with a retry delay — never the 500 a genuine bug is. These cases drive a
// scripted pool (no database) so each fault is raised at exactly one point of the transaction.

const CTX: DocStoreContext = { appId: 'ab_CONNFAULTAPP', ns: 'prod', viewerUid: 4242 };

/** The retryable refusal every connection fault becomes; `details` carries nothing of the cause. */
const UNAVAILABLE = {
  name: 'DocStoreError',
  code: 'service_unavailable',
  details: { retryAfter: 1 },
};

function pgError(code: string, message = `pg error ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

function errnoError(code: string): Error {
  // The shape a node socket error has: an errno-style `code`, a message naming the peer.
  return Object.assign(new Error(`${code} 192.0.2.10:5432`), { code, errno: -1, syscall: 'read' });
}

type Script = {
  /** Reject `connect()` with this. */
  connect?: Error;
  /** Fail the statement `sql` matches with this error; `rollback` too when set. */
  failOn?: (sql: string) => Error | undefined;
};

/** A pool whose one connection passes the role check and then fails as scripted. */
function scriptedDb(script: Script) {
  const sent: string[] = [];
  const released: unknown[] = [];
  const db: DocStoreDb = {
    async connect() {
      if (script.connect) throw script.connect;
      const client: DocStoreClient = {
        async query(sql) {
          sent.push(sql);
          const fault = script.failOn?.(sql);
          if (fault) throw fault;
          if (sql.includes('pg_roles')) {
            return {
              rows: [{ rolname: 'appdata_rw', rolsuper: false, rolbypassrls: false }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release(arg) {
          released.push(arg);
        },
      };
      return client;
    },
  };
  return { db, sent, released };
}

const isBegin = (sql: string) => sql.startsWith('BEGIN');
const isRole = (sql: string) => sql.includes('pg_roles');
/** A statement inside the transaction: not the role check, BEGIN, COMMIT or ROLLBACK. */
const isInTx = (sql: string) =>
  !isRole(sql) && !isBegin(sql) && sql !== 'COMMIT' && sql !== 'ROLLBACK';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
});

describe('doc-store: a connection the pool cannot hand out is a retryable service_unavailable', () => {
  it.each([
    ["the pool's connection timeout", new Error('timeout exceeded when trying to connect')],
    [
      "the client's connect timeout, wrapped by the pool",
      new Error('Connection terminated due to connection timeout', {
        cause: new Error('Connection terminated unexpectedly'),
      }),
    ],
    ['a refused socket', errnoError('ECONNREFUSED')],
    ['too many connections', pgError('53300', 'sorry, too many clients already')],
    ['the server starting up', pgError('57P03', 'the database system is starting up')],
    [
      'a PgBouncer that cannot reach the server',
      pgError('08P01', 'pgbouncer cannot connect to server'),
    ],
  ])('%s', async (_name, fault) => {
    const { db, sent } = scriptedDb({ connect: fault });
    const store = createDocStore({ db });
    const err = await rejection(store.get(CTX, PREFS, 'k'));
    expect(err).toBeInstanceOf(DocStoreError);
    expect(err).toMatchObject(UNAVAILABLE);
    // The message names the cause for the store's internal callers, which log it (the account
    // wipe, review cleanup); the route never sends it — pinned in doc-store-api.contract.test.ts.
    expect((err as Error).message).toBe(`storage is temporarily unavailable: ${fault.message}`);
    expect(sent).toEqual([]);
    // ...but the original is logged, since the route no longer sees it.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-blocks-doc-store-connection-fault',
        message: fault.message,
      }),
      'app-blocks'
    );
  });
});

describe('doc-store: a connect() rejection that is misconfiguration, not an outage, stays a 500', () => {
  // Retrying these never helps: a 503 "temporarily unavailable" would be an endless retry loop
  // that hides a broken deploy.
  it.each([
    ['a wrong password (28P01)', pgError('28P01', 'password authentication failed for user "x"')],
    ['an auth rule refusing the role (28000)', pgError('28000', 'no pg_hba.conf entry for host')],
    ['a missing database (3D000)', pgError('3D000', 'database "nope" does not exist')],
    ['a host name that does not resolve (ENOTFOUND)', errnoError('ENOTFOUND')],
    ['a host name DNS cannot answer for (EAI_AGAIN)', errnoError('EAI_AGAIN')],
    [
      'a pooler refusing a startup parameter (08P01)',
      pgError('08P01', 'unsupported startup parameter: statement_timeout'),
    ],
    ['a pool already ended', new Error('Cannot use a pool after calling end on the pool')],
  ])('%s', async (_name, fault) => {
    const { db, sent } = scriptedDb({ connect: fault });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toBe(fault);
    expect(sent).toEqual([]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-blocks-doc-store-config-fault',
        type: 'error',
        message: fault.message,
      }),
      'app-blocks'
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app-blocks-doc-store-connection-fault' }),
      expect.anything()
    );
  });
});

describe('doc-store: a connection-class failure inside the transaction is a retryable service_unavailable', () => {
  it.each([
    ['53300 too_many_connections', pgError('53300')],
    [
      '57P01 admin_shutdown',
      pgError('57P01', 'terminating connection due to administrator command'),
    ],
    ['57P02 crash_shutdown', pgError('57P02')],
    ['57P03 cannot_connect_now', pgError('57P03')],
    ['08000 connection_exception', pgError('08000')],
    ['08003 connection_does_not_exist', pgError('08003')],
    ['08006 connection_failure', pgError('08006')],
    ["08P01 from PgBouncer: 'server conn crashed?'", pgError('08P01', 'server conn crashed?')],
    [
      "08P01 from PgBouncer: 'no more connections allowed'",
      pgError('08P01', 'no more connections allowed (max_client_conn)'),
    ],
    [
      "08P01 from PgBouncer: 'pgbouncer cannot connect to server'",
      pgError('08P01', 'pgbouncer cannot connect to server'),
    ],
    ["08P01 from PgBouncer: 'query_wait_timeout'", pgError('08P01', 'query_wait_timeout')],
    ['ECONNRESET', errnoError('ECONNRESET')],
    ['ECONNREFUSED', errnoError('ECONNREFUSED')],
    ['EPIPE', errnoError('EPIPE')],
    ['ETIMEDOUT', errnoError('ETIMEDOUT')],
    ["'Connection terminated unexpectedly'", new Error('Connection terminated unexpectedly')],
    ["'Connection terminated'", new Error('Connection terminated')],
    [
      'a client the driver has already marked broken',
      new Error('Client has encountered a connection error and is not queryable'),
    ],
    [
      'a connection fault carried as the cause',
      new Error('query failed', { cause: errnoError('ECONNRESET') }),
    ],
  ])('%s on a statement after BEGIN', async (_name, fault) => {
    const { db, sent } = scriptedDb({ failOn: (sql) => (isInTx(sql) ? fault : undefined) });
    const store = createDocStore({ db });
    const err = await rejection(store.get(CTX, PREFS, 'k'));
    expect(err).toMatchObject(UNAVAILABLE);
    expect(sent.some(isInTx)).toBe(true);
    expect(sent).toContain('ROLLBACK');
    expect(sent).not.toContain('COMMIT');
  });

  it('on BEGIN itself', async () => {
    const { db } = scriptedDb({ failOn: (sql) => (isBegin(sql) ? pgError('57P01') : undefined) });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toMatchObject(UNAVAILABLE);
  });

  it('on the first-use role check', async () => {
    const { db, released } = scriptedDb({
      failOn: (sql) => (isRole(sql) ? new Error('Connection terminated unexpectedly') : undefined),
    });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toMatchObject(UNAVAILABLE);
    expect(released).toHaveLength(1);
  });

  it('mid-write, with the ROLLBACK failing too: the dead connection is destroyed, not pooled', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { db, sent, released } = scriptedDb({
      failOn: (sql) => (isInTx(sql) || sql === 'ROLLBACK' ? lost : undefined),
    });
    const err = await rejection(createDocStore({ db }).put(CTX, PREFS, 'k', { a: 1 }));
    expect(err).toMatchObject(UNAVAILABLE);
    expect(sent.filter(isBegin)).toHaveLength(1);
    expect(sent).toContain('ROLLBACK');
    expect(released).toEqual([true]);
  });
});

describe('doc-store: what stays as it was', () => {
  it.each([
    ['an undefined column (a bug in our SQL)', pgError('42703', 'column "nope" does not exist')],
    ['a syntax error', pgError('42601')],
    ['a unique violation', pgError('23505')],
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'rows')")],
    // A 5-character SQLSTATE that merely CONTAINS 08 is not class 08.
    ['SQLSTATE 22008 (datetime overflow)', pgError('22008')],
    // 08P01 is also what Postgres raises for a malformed message from US — a bug, not an outage.
    [
      '08P01 protocol_violation from a parameter-count bug',
      pgError('08P01', 'bind message supplies 1 parameters, but prepared statement "" requires 2'),
    ],
  ])('%s inside the transaction is rethrown untouched (the route sends 500)', async (_n, fault) => {
    const { db } = scriptedDb({ failOn: (sql) => (isInTx(sql) ? fault : undefined) });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toBe(fault);
  });

  it('a connection lost on COMMIT is NOT retryable: the write may have landed', async () => {
    const lost = new Error('Connection terminated unexpectedly');
    const { db } = scriptedDb({ failOn: (sql) => (sql === 'COMMIT' ? lost : undefined) });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toBe(lost);
  });

  it('INVARIANT GUARD: lock contention (55P03) is still rate_limited, not service_unavailable', async () => {
    const { db } = scriptedDb({ failOn: (sql) => (isInTx(sql) ? pgError('55P03') : undefined) });
    const err = await rejection(createDocStore({ db }).get(CTX, PREFS, 'k'));
    expect(err).toMatchObject({ code: 'rate_limited', details: { reason: 'contention' } });
  });

  it('INVARIANT GUARD: no pool at all is still storage_disabled', async () => {
    const err = await rejection(createDocStore({ db: null }).get(CTX, PREFS, 'k'));
    expect(err).toMatchObject({ code: 'storage_disabled' });
  });
});
