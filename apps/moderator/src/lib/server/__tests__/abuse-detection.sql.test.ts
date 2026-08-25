import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FINDINGS_PER_REPORT } from '@civitai/moderation';
import type { AbuseDetectionTables } from '../abuse-detection-tables';

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

/**
 * 🔴 `DummyDriver` alone returns NO rows, which stops a chain at its first `executeTakeFirstOrThrow`
 * (or its first `if (!row) return null`) — so the statements AFTER that one are never compiled and
 * are invisible to this tier. That is not a cosmetic gap: it left the `DELETE FROM
 * abuse_detection_finding` unreachable, and a mutant widening its `WHERE` to every run in the table
 * passed the entire suite.
 *
 * Returning a canned row lets every statement compile. The driver ignores the SQL entirely and
 * answers EVERY query with `cannedRows`, so a test that wants the empty path sets it — the row count
 * a chain sees is fixed here, never by the query's own LIMIT.
 *
 * The id is deliberately NOT 1. `run.id` from the run insert flows into the findings DELETE and
 * INSERT, so a distinctive value lets those assert the id they were given rather than accepting any
 * number — otherwise dropping `.returning('id')` is invisible here while breaking outright against a
 * real driver (`run.id` undefined → DELETE scoped to NULL, INSERT violating `run_id NOT NULL`).
 */
const CANNED_RUN_ID = 4242;
let cannedRows: unknown[] = [{ id: CANNED_RUN_ID }];

class CannedRowDriver extends DummyDriver {
  async acquireConnection(): Promise<DatabaseConnection> {
    return {
      // Generic in `R`, matching `DatabaseConnection` — a concrete row type here does not satisfy it
      // and svelte-check rejects the whole dialect.
      executeQuery: async <R>() => ({ rows: cannedRows as R[] }),
      streamQuery: async function* () {
        yield { rows: [] };
      },
    };
  }
}

function compileOnlyDb() {
  return new Kysely<AbuseDetectionTables>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new CannedRowDriver(),
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

// `withTables` is a TYPE-level operation that returns the same client, so the mock returns an
// object carrying it — the service calls `getModeratorDb().withTables<…>()`.
vi.mock('../moderator-db', () => ({
  getModeratorDb: () => {
    const db = compileOnlyDb();
    return Object.assign(db, { withTables: () => db });
  },
}));

const service = await import('../abuse-detection.service');

beforeEach(() => {
  sql.length = 0;
  (params as unknown[][]).length = 0;
  cannedRows = [{ id: CANNED_RUN_ID }];
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
    // 🔴 The bound VALUE, not just the placeholder. `$1` matches whatever was bound, so a regex over
    // the SQL text alone cannot see the predicate inverted to `false` — which would report the
    // NOT-actioned count under the "acted on" column, the one number this board exists to separate.
    expect(params[params.length - 1]).toContain(true);
  });

  // Sibling of the `getAbuseFindings` default the last round pinned. Unpinned, the board's list
  // silently shows a handful of runs and reads as "that is all there is".
  it('getAbuseRuns defaults to a page of 50 runs', async () => {
    await service.getAbuseRuns({});
    expect(params[params.length - 1]).toContain(50);
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

  // The default is the CONTRACT's cap, so the reader can never drop rows the writer accepted. Every
  // other test passes an explicit limit, which left the default unpinned: lowering it to 100 — a
  // silent 900-row truncation on a conforming report — survived the whole suite.
  it('defaults to the contract cap, so the reader cannot be narrower than the writer', async () => {
    await service.getAbuseFindings(7);
    expect(params[params.length - 1]).toContain(MAX_FINDINGS_PER_REPORT + 1);
  });

  // 🔴 Before the canned row this was the ONLY path any test took, and it was unasserted; after it,
  // the path became unreachable. If it regressed, a merely-nonexistent run would throw on
  // `row.id`, the route would catch it, and a 404 would render as "could not reach the database" —
  // the exact misdiagnosis the discriminated statuses exist to prevent.
  it('getAbuseRun returns null for a run that does not exist', async () => {
    cannedRows = [];
    await expect(service.getAbuseRun(999)).resolves.toBeNull();
    // And it stops there rather than issuing the counts query for a run it did not find.
    expect(sql).toHaveLength(1);
  });

  it('getAbuseFindings orders by confidence then id, and over-fetches by one to detect the cap', async () => {
    await service.getAbuseFindings(7, 10);
    const q = lastSql();
    // 🔴 Scoped to the run. Without this the detail page for run N renders EVERY finding in the
    // table ranked by confidence — the same defect gated below for `getAbuseRun`'s counts, on the
    // sibling query feeding the same screen.
    expect(q).toContain('where "run_id" = $');
    expect(params[params.length - 1]).toContain(7);
    expect(q).toContain('order by "confidence" desc, "id" asc');
    // `limit + 1` is how truncation is detected; a bare `limit` would make `truncated` always false.
    expect(params[params.length - 1]).toContain(11);
  });

  // What the function DOES with the extra row is behaviour the compiled SQL cannot show: `>` → `>=`
  // (a full page falsely reporting "showing the first N of N") and dropping the `.slice` (rendering
  // N+1 rows while claiming N) both used to survive.
  //
  // ⚠️ The driver returns ONE row for every query regardless of the compiled LIMIT, so these cases
  // are driven by varying the limit against that fixed count — not by the query actually fetching a
  // different number. The `limit + 1` over-fetch is pinned separately, by the parameter assertion
  // above; nothing here observes it.
  describe('truncation', () => {
    it('reports truncated when the query came back over the limit', async () => {
      // One row back (the driver's fixed count) against a limit of 0 — more than asked for.
      const { findings, truncated } = await service.getAbuseFindings(7, 0);
      expect(truncated).toBe(true);
      expect(findings).toHaveLength(0); // the probe row is dropped, never rendered
    });

    it('does not report truncated when the row count merely reaches the limit', async () => {
      // One row back against a limit of 1 — exactly the limit, so not truncated. `>=` fails here.
      const { findings, truncated } = await service.getAbuseFindings(7, 1);
      expect(truncated).toBe(false);
      expect(findings).toHaveLength(1);
    });

    // 🔴 THE PER-USER READ NEEDS THE SAME TWO CASES, and for a while it did not have them. It was
    // given the identical `limit + 1` / slice / `>` treatment as its sibling above, but only the
    // over-fetch PARAMETER was pinned — so hardcoding `truncated: false`, or dropping the `.slice`,
    // both survived a fully green suite. The consequence is specific: this function feeds the
    // account panel, which renders `capped` from `truncated`, so a silent `false` makes an account
    // with 300 findings read "Abuse detections (50)" and a moderator conclude they have seen the
    // whole record. Same harness, same asymmetry-closing pair.
    it('reports truncated for the per-user read when the query came back over the limit', async () => {
      const { findings, truncated } = await service.getAbuseFindingsForUser(99, 0);
      expect(truncated).toBe(true);
      expect(findings).toHaveLength(0); // the probe row is dropped, never rendered
    });

    it('does not report truncated for the per-user read at exactly the limit', async () => {
      const { findings, truncated } = await service.getAbuseFindingsForUser(99, 1);
      expect(truncated).toBe(false);
      expect(findings).toHaveLength(1);
    });
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

  it('recordAbuseRun upserts on the idempotency key, refreshing the receipt time', async () => {
    await service.recordAbuseRun({
      detector: 'reaction-abuse',
      startedAt: '2026-08-21T11:00:00.000Z',
      finishedAt: '2026-08-21T11:04:00.000Z',
      summary: 'daily',
      counters: { candidates: 9 },
      findings: [{ userId: 7, confidence: 0.9, reason: 'r', actioned: true, action: 'exclude' }],
    });

    const all = sql.map((s) => s.replace(/\s+/g, ' '));
    const insertRun = all.find((s) => s.includes('insert into "abuse_detection_run"'));
    // The conflict target must be EXACTLY the pair the unique index is on, or every write fails at
    // runtime with 42P10 "no unique or exclusion constraint matching the ON CONFLICT specification".
    expect(insertRun).toContain('on conflict ("detector", "started_at") do update set');
    // A replay must refresh what it re-reports, or the page shows new data under an old timestamp.
    for (const col of ['"finished_at"', '"summary"', '"counters"', '"received_at"'])
      expect(insertRun?.slice(insertRun.indexOf('do update set'))).toContain(col);
  });

  // 🔴 The one destructive statement in the write path. A mutant widening this WHERE to `run_id > 0`
  // — every report wiping every finding of every run — passed the whole suite before this existed.
  it('clears ONLY the findings of the run being written, and does so before re-inserting', async () => {
    await service.recordAbuseRun({
      detector: 'reaction-abuse',
      startedAt: '2026-08-21T11:00:00.000Z',
      finishedAt: '2026-08-21T11:04:00.000Z',
      findings: [{ userId: 7, confidence: 0.9, reason: 'r', actioned: true, action: 'exclude' }],
    });

    const all = sql.map((s) => s.replace(/\s+/g, ' '));
    const del = all.find((s) => s.startsWith('delete from "abuse_detection_finding"'));
    expect(del).toBeDefined();
    expect(del).toContain('where "run_id" = $1');
    // The VALUE, not just the placeholder: this is the id the run insert returned, so dropping
    // `.returning('id')` — invisible to a placeholder-only assertion — fails here.
    const delParams = params[sql.findIndex((s2) => s2.startsWith('delete from'))];
    expect(delParams).toEqual([CANNED_RUN_ID]);

    const delAt = all.findIndex((s) => s.startsWith('delete from "abuse_detection_finding"'));
    const insAt = all.findIndex((s) => s.startsWith('insert into "abuse_detection_finding"'));
    expect(delAt).toBeGreaterThanOrEqual(0);
    expect(insAt).toBeGreaterThan(delAt);
  });

  // The header read short-circuits on a missing row, so without a row-returning driver this second
  // statement never compiled — three wrong versions of it shipped green.
  it('getAbuseRun scopes its counts to the run, and counts actioned separately', async () => {
    await service.getAbuseRun(42);

    const counts = sql.map((s) => s.replace(/\s+/g, ' ')).find((s) => s.includes('count('));
    expect(counts).toBeDefined();
    expect(counts).toContain('from "abuse_detection_finding"');
    // Table-wide counts on every run's page is the mutant this kills.
    expect(counts).toContain('where "run_id" = $');
    expect(counts).toMatch(/count\("id"\) as "finding_count"/);
    expect(counts).toMatch(
      /count\(case when "actioned" = \$\d+ then "id" end\) as "actioned_count"/
    );
    // Same reason as above: the placeholder matches an inverted predicate just as well.
    const countsParams = params[sql.findIndex((s2) => s2.includes('count('))];
    expect(countsParams).toContain(true);
    expect(countsParams).toContain(42);
  });
});
