import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbuseDetectionDB } from '../abuse-detection-db';

/**
 * The SQL these queries actually compile to, asserted without a database.
 *
 * 🔴 Why this tier exists at all. `AbuseDetectionDB` is a HAND-WRITTEN interface for tables no
 * generator knows about, so nothing checks it against `abuse-detection/schema.sql` — a column
 * renamed on one side and not the other typechecks perfectly and fails at runtime. These tests are
 * not a substitute for running the queries (they cannot see whether the SCHEMA matches), but they
 * do pin the column names, the join, the grouping, the ordering and the conflict target, which is
 * where a silent mismatch would hide.
 *
 * `DummyDriver` compiles and never connects — the same mechanism `src/test/explain-harness.ts` uses
 * for the report queries. The alternative considered and rejected was a resolving fake: one good
 * enough to answer these chains would answer from a fixture rather than the recorded query, so it
 * could not tell a correctly-scoped query from one scoped to the wrong rows.
 */

const sql: string[] = [];
const params: readonly unknown[][] = [];

function compileOnlyDb() {
  return new Kysely<AbuseDetectionDB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') {
        sql.push(event.query.sql);
        (params as unknown[][]).push([...event.query.parameters]);
      }
    },
  });
}

vi.mock('../abuse-detection-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../abuse-detection-db')>()),
  getAbuseDetectionDb: () => compileOnlyDb(),
}));

const service = await import('../abuse-detection.service');

beforeEach(() => {
  sql.length = 0;
  (params as unknown[][]).length = 0;
});

/** Whitespace-normalised, so a prettier reflow of the builder chain cannot fail these. */
const lastSql = () => sql[sql.length - 1].replace(/\s+/g, ' ').trim();

describe('compiled SQL — column names and shape', () => {
  it('getAbuseRuns joins findings and groups by the run PK alone', async () => {
    await service.getAbuseRuns({});
    const q = lastSql();

    expect(q).toContain('from "abuse_detection_run" as "r"');
    expect(q).toContain('left join "abuse_detection_finding" as "f" on "f"."run_id" = "r"."id"');
    // Grouping by the PK alone relies on Postgres's functional dependency — listing the `jsonb`
    // column too works but would break on a `json` column.
    expect(q).toContain('group by "r"."id"');
    expect(q).toContain('order by "r"."started_at" desc');
    // A conditional COUNT, never SUM over a boolean: through the LEFT JOIN `actioned` is nullable,
    // and SUM of all-NULLs is NULL, which `Number(null)` would render as a confident 0.
    expect(q).toMatch(/count\(case when "f"\."actioned" = \$\d+ then "f"\."id" end\)/);
  });

  it('getAbuseRuns filters by detector only when one is given', async () => {
    await service.getAbuseRuns({});
    expect(lastSql()).not.toContain('"r"."detector" =');

    await service.getAbuseRuns({ detector: 'reaction-abuse' });
    expect(lastSql()).toContain('"r"."detector" =');
    expect(params[params.length - 1]).toContain('reaction-abuse');
  });

  it('getAbuseRun reads one row by primary key', async () => {
    await service.getAbuseRun(42);
    // The FIRST of the two statements it issues — the header read.
    expect(sql[0].replace(/\s+/g, ' ')).toContain('from "abuse_detection_run"');
    expect(sql[0]).toContain('"id" =');
    expect(params[0]).toContain(42);
  });

  it('getAbuseFindings orders by confidence then id, and over-fetches by one to detect the cap', async () => {
    await service.getAbuseFindings(7, 10);
    const q = lastSql();
    expect(q).toContain('order by "confidence" desc, "id" asc');
    // `limit + 1` is how truncation is detected; a bare `limit` would make `truncated` always false.
    expect(params[params.length - 1]).toContain(11);
  });

  it('getAbuseFindingsForUser is ordered newest-first and NOT filtered on actioned', async () => {
    await service.getAbuseFindingsForUser(99);
    const q = lastSql();
    expect(q).toContain('"user_id" =');
    expect(q).toContain('order by "created_at" desc');
    // "We looked at this account twice and did nothing" is a real answer to a creator's complaint,
    // and the most common one.
    expect(q).not.toContain('"actioned"');
  });

  it('recordAbuseRun upserts on the idempotency key and clears findings before re-inserting', async () => {
    // `DummyDriver` compiles without returning rows, so the run insert's
    // `executeTakeFirstOrThrow()` throws "no result" — AFTER Kysely has logged the compiled query,
    // which is the whole subject here. Swallowed deliberately; the assertions below are on the SQL,
    // and an empty `sql` would fail them rather than pass vacuously.
    await service
      .recordAbuseRun({
        detector: 'reaction-abuse',
        startedAt: '2026-08-21T11:00:00.000Z',
        finishedAt: '2026-08-21T11:04:00.000Z',
        findings: [{ userId: 7, confidence: 0.9, reason: 'r', actioned: true, action: 'exclude' }],
      })
      .catch(() => undefined);

    const all = sql.map((s) => s.replace(/\s+/g, ' '));
    expect(all.length).toBeGreaterThan(0);
    const insertRun = all.find((s) => s.includes('insert into "abuse_detection_run"'));
    // The conflict target must be exactly the pair the unique index is on, or the upsert throws at
    // runtime: "no unique or exclusion constraint matching the ON CONFLICT specification".
    expect(insertRun).toContain('on conflict ("detector", "started_at") do update set');

    // The statements AFTER this one cannot be compiled here — the run insert's
    // `executeTakeFirstOrThrow` aborts the transaction under DummyDriver before they are reached.
    // Their order is asserted in `abuse-detection.test.ts`, against the recorded builder chain.
  });
});
