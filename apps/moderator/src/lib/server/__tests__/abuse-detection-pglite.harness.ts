import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery as CompiledQueryType,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { AbuseDetectionTables } from '../abuse-detection-tables';

/**
 * `apps/moderator/abuse-detection/schema.sql`, APPLIED to a real Postgres.
 *
 * 🔴 WHY THIS TIER EXISTS, AND WHY THE EXISTING TWO CANNOT COVER IT. `abuse-detection.test.ts` fakes
 * the builder and asserts what was passed to it; `abuse-detection.sql.test.ts` compiles the queries
 * and asserts their text. Neither has ever executed a statement, so NOTHING in this app had any
 * claim on the DDL at all: a CHECK constraint that admits the wrong set, a column the code writes
 * and the table does not have, and a file that is not re-runnable would all pass both tiers.
 *
 * PGlite is Postgres compiled to WASM, in-process — the same instrument
 * `<civitai>/src/server/services/__tests__/listForModel.harness.ts` uses. It is NOT a stand-in that
 * approximates Postgres: the CHECK violations these tests assert come back with the real `23514`,
 * from the real constraint, parsed from the real file.
 *
 * 🔴 IT IS NOT SKIPPABLE, AND THAT IS THE POINT. The EXPLAIN tier in this directory is
 * `describe.skipIf(!h.hasDb)` and therefore does not run in CI or on a machine without `.env` — a
 * test that skips itself proves nothing. This one needs no server, so it runs everywhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/lib/server/__tests__` → the app root, where `abuse-detection/schema.sql` lives. */
export const SCHEMA_PATH = join(HERE, '../../../../abuse-detection/schema.sql');

export const readSchemaSql = (): string => readFileSync(SCHEMA_PATH, 'utf8');

/**
 * psql meta-commands removed — `\set ON_ERROR_STOP on` is an instruction to psql, not SQL, and the
 * server rejects it as a syntax error.
 *
 * 🔴 STRIPPING IT IS EXACTLY WHY A SEPARATE TEXTUAL ASSERTION ON THAT LINE IS REQUIRED. Applying the
 * file here says nothing about whether the directive is still in it, and the directive is what stops
 * psql sailing past a failed statement on the one deployment that needs it most (see the file's own
 * comment). Execution and presence are two different claims; this harness can only make the first.
 */
export function executableSchemaSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('\\') ? '' : line))
    .join('\n');
}

/** Apply the real DDL, verbatim apart from the psql meta-commands. */
export async function applySchema(db: PGlite): Promise<void> {
  await db.exec(executableSchemaSql(readSchemaSql()));
}

/**
 * A Kysely dialect over PGlite, so the SERVICE's own query builders run against real Postgres.
 *
 * 🔴 THE SERVICE, UNMODIFIED — that is the whole value. A fake builder can only be asked what it was
 * told; it cannot answer "did this UPDATE touch a row in another run", which is the question every
 * group-scoping guard in `recordAbuseVerdict` turns on. Those guards are about WHICH ROWS MOVE, and
 * only rows can answer.
 */
export function pgliteDialect(db: PGlite): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQueryType): Promise<QueryResult<R>> {
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return {
        rows: result.rows as R[],
        // 🔴 Kysely's `UpdateResult.numUpdatedRows` is derived from this field and nothing else.
        // Omitting it makes every update report 0 rows changed — which is the value
        // `recordAbuseVerdict` returns and the route branches on, so a harness that dropped it
        // would make the "zero rows is not success" refusal fire on every successful ruling.
        numAffectedRows: BigInt(result.affectedRows ?? 0),
      };
    },
    // Throws rather than answering nothing: a silent empty stream would look like a query that
    // legitimately found no rows. Nothing in this service streams, and if something starts to, this
    // is where it should stop rather than quietly return the wrong answer.
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('streaming is not used by the abuse-detection service');
    },
  };

  /** The three lifecycle hooks PGlite has no analogue for — it is one in-process database. */
  const noop = async () => undefined;

  const driver: Driver = {
    init: noop,
    async acquireConnection() {
      return connection;
    },
    // Real transactions: `recordAbuseRun` writes a run and its findings in one, and the harness must
    // not quietly turn that into two independent writes.
    async beginTransaction(conn) {
      await conn.executeQuery(CompiledQuery.raw('begin'));
    },
    async commitTransaction(conn) {
      await conn.executeQuery(CompiledQuery.raw('commit'));
    },
    async rollbackTransaction(conn) {
      await conn.executeQuery(CompiledQuery.raw('rollback'));
    },
    releaseConnection: noop,
    destroy: noop,
  };

  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

/** A client typed exactly as the service's own, over the in-process database. */
export function pgliteKysely(db: PGlite): Kysely<AbuseDetectionTables> {
  return new Kysely<AbuseDetectionTables>({ dialect: pgliteDialect(db) });
}

/** A fresh in-process Postgres with the real schema applied. */
export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await applySchema(db);
  return db;
}

/** One run header, returning its id. Findings are inserted by the tests that need them. */
export async function seedRun(db: PGlite, detector: string, startedAt: string): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO abuse_detection_run (detector, started_at, finished_at)
     VALUES ($1, $2::timestamptz, $2::timestamptz) RETURNING id`,
    [detector, startedAt]
  );
  return Number(res.rows[0].id);
}

/** One finding, returning its id. `actioned`/`action` default to the producer's common case. */
export async function seedFinding(
  db: PGlite,
  row: {
    runId: number;
    userId: number;
    confidence?: number;
    reason?: string;
    actioned?: boolean;
    action?: string | null;
    groupKey?: string | null;
  }
): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO abuse_detection_finding
       (run_id, user_id, confidence, reason, actioned, action, group_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      row.runId,
      row.userId,
      row.confidence ?? 0.5,
      row.reason ?? 'seeded',
      row.actioned ?? false,
      row.action ?? null,
      row.groupKey ?? null,
    ]
  );
  return Number(res.rows[0].id);
}

export type FindingRow = {
  id: number;
  run_id: number;
  user_id: number;
  actioned: boolean;
  action: string | null;
  verdict: string | null;
  verdict_by: string | null;
  verdict_at: Date | null;
  group_key: string | null;
};

/** Every finding in the database, id order — the ledger the group-scoping assertions read. */
export async function allFindings(db: PGlite): Promise<FindingRow[]> {
  const res = await db.query<FindingRow>(
    `SELECT id, run_id, user_id, actioned, action, verdict, verdict_by, verdict_at, group_key
       FROM abuse_detection_finding ORDER BY id`
  );
  return res.rows;
}
