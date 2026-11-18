import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { DB_LOG_FLAG, log } from './db';

// The pools' query echo is opt-in: `cancellableQuery` hands every statement's text, including any
// values formatted into it, to the logger it was built with, so an always-on logger prints every query.

describe('log (the pools logger)', () => {
  let consoleLog: MockInstance<typeof console.log>;
  let savedLogging: string | undefined;
  beforeEach(() => {
    // An explicit `undefined` falls back to `process.env.LOGGING`, so the "unset" case is only
    // unset if the environment's own LOGGING is cleared for it.
    savedLogging = process.env.LOGGING;
    delete process.env.LOGGING;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleLog.mockRestore();
    if (savedLogging === undefined) delete process.env.LOGGING;
    else process.env.LOGGING = savedLogging;
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['other flags only', 'pgDb,prisma-slow'],
    ['a longer flag that merely starts with it', `${DB_LOG_FLAG}-verbose`],
  ])('is undefined when LOGGING is %s, and prints nothing', (_case, logging) => {
    expect(log('notif', logging)).toBeUndefined();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it.each([
    ['alone', DB_LOG_FLAG],
    ['among other flags, with spaces', `pgDb, ${DB_LOG_FLAG} ,prisma-slow`],
  ])('logs with the pool label when LOGGING contains notif-db %s', (_case, logging) => {
    const logger = log('main-read', logging);
    expect(logger).toBeTypeOf('function');
    logger?.('SELECT 1', 42);
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledWith('[notifications:db:main-read] SELECT 1', 42);
  });
});

// The seam: the module's own pools, built by the real `createPool`, which must accept the missing
// logger as a no-op. Pool construction does not connect, so a placeholder URL is enough. Both log
// paths are observed: the "Creating <label> client" line at construction, and the statement echo
// from a real `cancellableQuery`, run over a stubbed connection so nothing reaches a database.
describe('the module pools', () => {
  const TOUCHED = ['LOGGING', 'NOTIFICATION_DB_URL', 'NOTIFICATION_DB_REPLICA_URL'];
  let saved: Record<string, string | undefined> = {};
  let consoleLog: MockInstance<typeof console.log>;

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    process.env.NOTIFICATION_DB_URL = 'postgres://user:pass@localhost:5432/notifications';
    delete process.env.NOTIFICATION_DB_REPLICA_URL;
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.resetModules();
  });

  afterEach(() => {
    consoleLog.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  const dbLines = () =>
    consoleLog.mock.calls.filter(
      ([first]) => typeof first === 'string' && first.startsWith('[notifications:db:')
    );

  // The shape the app's callers use: values formatted into the statement text (pg-format `%L`).
  const STATEMENT = `SELECT 'formatted-into-text' AS v`;

  /** Builds the write pool and runs one statement through its real `cancellableQuery`. */
  async function runOneQuery() {
    const db = await import('./db');
    const pool = db.notifDbWrite();
    const connection = {
      processID: 1,
      query: vi.fn(async () => ({ rows: [{ v: 'formatted-into-text' }] })),
      release: vi.fn(),
    };
    pool.connect = vi.fn(async () => connection) as unknown as typeof pool.connect;
    const query = await pool.cancellableQuery(STATEMENT);
    expect(await query.result()).toEqual([{ v: 'formatted-into-text' }]);
    expect(connection.query).toHaveBeenCalledWith(STATEMENT);
    return pool;
  }

  it('builds a pool, runs a query and prints nothing when LOGGING is unset', async () => {
    delete process.env.LOGGING;
    const pool = await runOneQuery();
    expect(dbLines()).toEqual([]);
    await pool.end();
  });

  it('echoes the statement through the pool when LOGGING contains notif-db', async () => {
    process.env.LOGGING = DB_LOG_FLAG;
    const pool = await runOneQuery();
    expect(dbLines()).toEqual([
      ['[notifications:db:notif] Creating notif client'],
      ['[notifications:db:notif] notif', STATEMENT],
    ]);
    await pool.end();
  });
});
