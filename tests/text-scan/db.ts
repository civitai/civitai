import pg from 'pg';
import { e2eEnv } from './env';
import { parseUtcTimestamp } from './logic';

const TIMESTAMP_WITHOUT_TZ_OID = 1114;

// pg's default reads `timestamp without time zone` in the machine's local zone; Prisma writes UTC.
const getTypeParser = ((oid: number, format?: string) =>
  oid === TIMESTAMP_WITHOUT_TZ_OID && format !== 'binary'
    ? parseUtcTimestamp
    : pg.types.getTypeParser(oid, format as 'text')) as typeof pg.types.getTypeParser;

let pool: pg.Pool | undefined;

function db() {
  pool ??= new pg.Pool({
    connectionString: e2eEnv().TEXT_SCAN_E2E_DB_URL,
    max: 4,
    types: { getTypeParser },
  });
  return pool;
}

export async function many<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db().query(sql, params)).rows as T[];
}

export async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await many<T>(sql, params))[0];
}

export async function dbNow(): Promise<Date> {
  return (await one<{ now: Date }>('SELECT clock_timestamp() AS now'))!.now;
}

/** `$n`, bound as an ISO string, as the UTC wall-clock value a `timestamp` column holds. */
export const utcParam = (n: number) => `($${n}::timestamptz AT TIME ZONE 'UTC')`;

/** Round-trips a timestamp through a `timestamp(3)` column and checks the freshness predicate both ways. */
export async function timestampSelfCheck() {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE e2e_ts_check (ts timestamp(3) NOT NULL) ON COMMIT DROP');
    const written = new Date(Math.floor(Date.now() / 1000) * 1000 + 123);
    await client.query(`INSERT INTO e2e_ts_check (ts) VALUES (${utcParam(1)})`, [
      written.toISOString(),
    ]);
    const { rows } = await client.query<{ ts: Date; after: boolean; before: boolean }>(
      `SELECT ts, ts > ${utcParam(1)} AS after, ts > ${utcParam(2)} AS before FROM e2e_ts_check`,
      [
        new Date(written.getTime() - 1_000).toISOString(),
        new Date(written.getTime() + 1_000).toISOString(),
      ]
    );
    const row = rows[0];
    if (row.ts.getTime() !== written.getTime())
      throw new Error(
        `timestamp round trip shifted: wrote ${written.toISOString()}, read ${row.ts.toISOString()}`
      );
    if (!row.after || row.before)
      throw new Error(`freshness predicate is wrong: after=${row.after} before=${row.before}`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}
