import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  CompiledQuery as CompiledQueryClass,
} from 'kysely';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * DB-backed tier, modelled on `packages/civitai-db-queries/src/test/harness.ts`. Catches what neither
 * TypeScript nor the mocked unit tier can: a wrong table or column inside the raw `sql` that
 * `reports.service.ts` assembles from `REPORT_ENTITIES`.
 *
 * 🔴 NOTHING IS EXECUTED. The query is compiled by a DummyDriver client and only the SQL text is
 * sent, as `EXPLAIN` WITHOUT `ANALYZE` — parsed and planned, never run, safe for writes too. A suite
 * here may PLAN against `DATABASE_URL` and must never write fixtures to it.
 */
export function testDbUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

export function explainHarness() {
  const queries: CompiledQuery[] = [];

  // No plugins, matching `$lib/server/db.ts` — any here would compile SQL this app never issues.
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') queries.push(event.query);
    },
  });

  const url = testDbUrl();
  const realDb = url
    ? createKyselyClients<DB>({ connectionString: url, singleClient: true, sslNoVerify: true }).db
    : null;

  async function explain(cq: CompiledQuery): Promise<string> {
    if (!realDb)
      throw new Error('explainHarness: no DB URL (set TEST_DATABASE_URL or DATABASE_URL)');
    return realDb.connection().execute(async (conn) => {
      const result = await conn.executeQuery<Record<string, string>>(
        CompiledQueryClass.raw(`explain ${cq.sql}`, [...cq.parameters])
      );
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  }

  return {
    db,
    queries,
    hasDb: !!realDb,
    reset: () => queries.splice(0, queries.length),
    /** ALL of them, not the last: one service call issues several (`getReports` counts, then pages). */
    explainAll: async () => {
      if (!queries.length) throw new Error('explainHarness: nothing was compiled to plan');
      return Promise.all(queries.map(explain));
    },
    destroy: () => realDb?.destroy() ?? Promise.resolve(),
  };
}
