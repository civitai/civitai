import { Prisma } from '@civitai/db-schema';
import { describe, expect, it } from 'vitest';
import {
  dbUnavailableCause,
  isDbConnectionError,
  isDbUnavailableError,
  isTransientDbConnectionError,
} from './db-errors';

// The shapes a brief primary failover produces, each as the driver raises it.

/** pg's DatabaseError carries the server's `severity` and SQLSTATE `code`. */
const pgError = (code: string, message: string, severity = 'FATAL') =>
  Object.assign(new Error(message), { code, severity });

const known = (code: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test' });

const unknown = (message: string) =>
  new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });

const POOLER_LOGIN_FAILING =
  'server login has been failing, cached error: connect failed (server_login_retry)';
const PRISMA_WRAPPED_LOGIN_FAILING = `Error in connector: Error querying the database: FATAL: ${POOLER_LOGIN_FAILING}`;

describe('the connection-unavailable family', () => {
  it.each([
    ['pg 08P01 from the pooler: login failing', () => pgError('08P01', POOLER_LOGIN_FAILING)],
    ['pg 08006 connection failure', () => pgError('08006', 'connection failure')],
    [
      'pg 08001 cannot establish',
      () => pgError('08001', 'sqlclient_unable_to_establish_sqlconnection'),
    ],
    [
      'pg 57P01 admin shutdown',
      () => pgError('57P01', 'terminating connection due to administrator command'),
    ],
    ['pg 57P03 cannot connect now', () => pgError('57P03', 'the database system is starting up')],
    ['Prisma P1001', () => known('P1001', "Can't reach database server")],
    ['Prisma P1017', () => known('P1017', 'Server has closed the connection.')],
    ['Prisma init P1001', () => new Prisma.PrismaClientInitializationError('x', 'test', 'P1001')],
    [
      'Prisma unknown error wrapping the pooler login failure',
      () => unknown(PRISMA_WRAPPED_LOGIN_FAILING),
    ],
    [
      'Prisma unknown error wrapping an admin shutdown',
      () =>
        unknown(
          'Error in connector: Error querying the database: FATAL: terminating connection due to administrator command'
        ),
    ],
  ])('%s is a connection error, unavailable, and transient', (_label, make) => {
    const e = make();
    expect(isDbConnectionError(e)).toBe(true);
    expect(isDbUnavailableError(e)).toBe(true);
    expect(isTransientDbConnectionError(e)).toBe(true);
  });

  it('a wrapped error is found through the cause chain, and only name and code are reported', () => {
    const e = new Error('service failed', { cause: unknown(PRISMA_WRAPPED_LOGIN_FAILING) });
    expect(dbUnavailableCause(e)).toEqual({ name: 'PrismaClientUnknownRequestError', code: '' });
  });

  // A full pool, pooler or server: answered with a 503, but a retry would only add load to it.
  it.each([
    [
      'pg 08P01 from the pooler: no more connections allowed',
      () => pgError('08P01', 'no more connections allowed (max_client_conn)'),
    ],
    ['pg 08P01 from the pooler: query_wait_timeout', () => pgError('08P01', 'query_wait_timeout')],
    ['pg 53300 too many connections', () => pgError('53300', 'sorry, too many clients already')],
    [
      'Prisma unknown error wrapping the pooler query_wait_timeout',
      () => unknown('Error in connector: Error querying the database: ERROR: query_wait_timeout'),
    ],
    [
      'Prisma unknown error wrapping no more connections allowed',
      () =>
        unknown(
          'Error in connector: Error querying the database: FATAL: no more connections allowed (max_client_conn)'
        ),
    ],
  ])('%s is unavailable (503) but not a connection error, and not retried', (_label, make) => {
    const e = make();
    expect(isDbUnavailableError(e)).toBe(true);
    expect(isDbConnectionError(e)).toBe(false);
    expect(isTransientDbConnectionError(e)).toBe(false);
  });

  it('P2024 (no pooled connection in time) is unavailable but not retried', () => {
    const e = known('P2024', 'Timed out fetching a new connection from the connection pool');
    expect(isDbUnavailableError(e)).toBe(true);
    expect(isTransientDbConnectionError(e)).toBe(false);
  });
});

describe('not the connection-unavailable family', () => {
  it.each([
    ['a unique-constraint violation (P2002)', () => known('P2002', 'Unique constraint failed')],
    [
      'a pg unique violation',
      () => pgError('23505', 'duplicate key value violates unique constraint', 'ERROR'),
    ],
    ['a pg syntax error', () => pgError('42601', 'syntax error at or near "SELEC"', 'ERROR')],
    // 08P01 is also what Postgres raises for a malformed message from the client: a bug, not an
    // outage, so it must stay a 500 and must not be retried.
    [
      'a pg 08P01 from a parameter-count bug',
      () =>
        pgError(
          '08P01',
          'bind message supplies 1 parameters, but prepared statement "" requires 2',
          'ERROR'
        ),
    ],
    [
      'a Prisma unknown error that is not a connection failure',
      () => unknown('Error in connector: Error querying the database: ERROR: division by zero'),
    ],
    // The same text from a non-Prisma error could be any dependency's.
    ['the pooler text on a plain Error', () => new Error(PRISMA_WRAPPED_LOGIN_FAILING)],
  ])('%s is not', (_label, make) => {
    const e = make();
    expect(isDbConnectionError(e)).toBe(false);
    expect(isDbUnavailableError(e)).toBe(false);
    expect(isTransientDbConnectionError(e)).toBe(false);
  });
});
