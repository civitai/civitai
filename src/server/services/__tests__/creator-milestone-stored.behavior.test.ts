import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MilestoneGrant } from '~/server/services/creator-milestone-grant.service';
import type { ActivityWatermark } from '~/server/services/creator-milestone-activity.service';
import { runActivityGroup } from '~/server/services/creator-milestone-activity.service';
import type {
  QueryClickhouse,
  StoredDetector,
  StoredMilestoneSkip,
} from '~/server/services/creator-milestone-stored';
import {
  findStoredCandidates,
  loadStoredMilestoneGroups,
  storedMilestoneGroups,
} from '~/server/services/creator-milestone-stored';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Stored detectors run against an in-process Postgres with every CreatorMilestone migration applied.
 * The fixtures are invented: a "Doodle" table nothing in the product has.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');
const KEY = 'test:teal';

const holder = { db: null as unknown as PGlite };
const statements: string[] = [];
const pool = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
  connect: async () => ({
    query: async (q: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
      const text = typeof q === 'string' ? q : q.text;
      statements.push(text);
      const result = await holder.db.query(text, typeof q === 'string' ? values : q.values);
      return { rows: result.rows, fields: result.fields };
    },
    release: vi.fn(),
  }),
} as never;
const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const TEAL_SQL = `SELECT d."userId", min(d."drawnAt") AS "achievedAt"
  FROM "Doodle" d WHERE d.color = 'teal' GROUP BY d."userId"`;

const detector = (overrides: Partial<StoredDetector> = {}): StoredDetector => ({
  type: 'query',
  sql: TEAL_SQL,
  dated: true,
  launchedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const find = (
  d: StoredDetector,
  options: {
    queryClickhouse?: QueryClickhouse;
    limits?: { timeoutMs: number; rowCap: number };
  } = {}
) => findStoredCandidates(pool, KEY, d, options);

const skipOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return e as StoredMilestoneSkip;
  }
  throw new Error('expected a skip');
};

async function doodle(userId: number, color: string, drawnAt: string) {
  await q(`INSERT INTO "Doodle" ("userId", color, "drawnAt") VALUES ($1, $2, $3::timestamptz)`, [
    userId,
    color,
    drawnAt,
  ]);
}

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, name text);
    CREATE TABLE "UserCosmetic" (
      "userId" int NOT NULL, "cosmeticId" int NOT NULL, "claimKey" text NOT NULL DEFAULT 'claimed',
      PRIMARY KEY ("userId", "cosmeticId", "claimKey")
    );
    CREATE TABLE "Doodle" (
      id serial PRIMARY KEY, "userId" int NOT NULL, color text NOT NULL, "drawnAt" timestamptz NOT NULL
    );
    CREATE TABLE "Scribble" (id serial PRIMARY KEY);
    CREATE FUNCTION scribble() RETURNS int LANGUAGE sql AS
      'INSERT INTO "Scribble" DEFAULT VALUES RETURNING id';
  `);
  const migrations = readdirSync(MIGRATIONS)
    .sort()
    .map((dir) => join(MIGRATIONS, dir, 'migration.sql'))
    .filter((file) => {
      try {
        return readFileSync(file, 'utf8').includes('"CreatorMilestone"');
      } catch {
        return false;
      }
    });
  for (const file of migrations) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  statements.length = 0;
  await holder.db.exec(`
    TRUNCATE "UserCosmetic", "UserCreatorMilestone", "User", "Doodle", "Scribble";
    DELETE FROM "CreatorMilestone" WHERE key LIKE 'test:%';
  `);
  for (const id of [1, 2, 3]) await q(`INSERT INTO "User" (id) VALUES ($1)`, [id]);
  await q(
    `INSERT INTO "CreatorMilestone" (key, track, hidden, name) VALUES ($1, 'hidden', true, 'Teal')`,
    [KEY]
  );
});

describe('findStoredCandidates', () => {
  it('returns each finder not yet holding the milestone, at their earliest moment', async () => {
    await doodle(1, 'teal', '2026-03-02T10:00:00Z');
    await doodle(1, 'teal', '2026-03-01T10:00:00Z');
    await doodle(2, 'teal', '2026-03-05T10:00:00Z');
    await doodle(3, 'red', '2026-03-05T10:00:00Z');
    await q(`INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey") VALUES (2, $1)`, [KEY]);

    expect(await find(detector())).toEqual([
      { userId: 1, milestoneKey: KEY, achievedAt: new Date('2026-03-01T10:00:00Z') },
    ]);
  });

  it('keeps the earliest of several rows for one user', async () => {
    await doodle(1, 'teal', '2026-03-05T00:00:00Z');
    await doodle(1, 'teal', '2026-03-01T00:00:00Z');
    await doodle(1, 'teal', '2026-03-09T00:00:00Z');
    const sql = `SELECT d."userId", d."drawnAt" AS "achievedAt" FROM "Doodle" d ORDER BY d.id`;
    expect(await find(detector({ sql }))).toEqual([
      { userId: 1, milestoneKey: KEY, achievedAt: new Date('2026-03-01T00:00:00Z') },
    ]);
  });

  it('runs the stored query inside a read-only transaction with a statement timeout', async () => {
    await find(detector(), { limits: { timeoutMs: 1234, rowCap: 10 } });
    expect(statements.slice(0, 2)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 1234',
    ]);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  // The stored text is the trust boundary: a write that slipped into it must fail, not land.
  it('refuses a stored query that writes, and nothing is written', async () => {
    const skip = await skipOf(
      find(detector({ sql: `SELECT scribble() AS "userId", now() AS "achievedAt"` }))
    );
    expect(skip.reason).toBe('read-only-violation');
    expect(await q(`SELECT count(*)::int AS n FROM "Scribble"`)).toEqual([{ n: 0 }]);
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it.each([
    ['an extra column', `SELECT 1 AS "userId", now() AS "achievedAt", 'x' AS extra`],
    ['a missing column', `SELECT 1 AS "userId"`],
    ['a bigint user id', `SELECT 1::bigint AS "userId", now() AS "achievedAt"`],
    ['a zone-less timestamp', `SELECT 1 AS "userId", now()::timestamp AS "achievedAt"`],
    ['a dated row with no moment', `SELECT 1 AS "userId", NULL::timestamptz AS "achievedAt"`],
    ['a non-positive user id', `SELECT 0 AS "userId", now() AS "achievedAt"`],
  ])('skips a result with %s', async (_, sql) => {
    expect((await skipOf(find(detector({ sql })))).reason).toBe('shape');
  });

  it('skips an undated definition whose rows carry a moment, and accepts NULL ones', async () => {
    const sql = (at: string) => `SELECT 1 AS "userId", ${at}::timestamptz AS "achievedAt"`;
    expect((await skipOf(find(detector({ dated: false, sql: sql('now()') })))).reason).toBe(
      'shape'
    );
    expect(await find(detector({ dated: false, sql: sql('NULL') }))).toEqual([
      { userId: 1, milestoneKey: KEY, achievedAt: null },
    ]);
  });

  // PGlite runs single-threaded and never fires statement_timeout, so Postgres's cancel is faked.
  it('skips a query that outruns its timeout, and rolls it back', async () => {
    const sent: string[] = [];
    const release = vi.fn();
    const cancelling = {
      connect: async () => ({
        query: async (q: string | { text: string }) => {
          const text = typeof q === 'string' ? q : q.text;
          sent.push(text);
          if (text.includes('AS stored'))
            throw Object.assign(new Error('canceling statement due to statement timeout'), {
              code: '57014',
            });
          return { rows: [], fields: [] };
        },
        release,
      }),
    } as never;
    const skip = await skipOf(findStoredCandidates(cancelling, KEY, detector(), {}));
    expect(skip.reason).toBe('timeout');
    expect(sent.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalled();
  });

  // node-postgres sends a query with no values over the simple protocol, which runs every statement
  // in the text, so a stored text could COMMIT its way out of READ ONLY. The held-key parameter means
  // a stored query always has one. Do not remove it without forcing the extended protocol another way.
  it('always sends the stored query with parameters, so it runs as a single statement', async () => {
    const sent: { text: string; values?: unknown[] }[] = [];
    const recording = {
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          sent.push({ text, values });
          return { rows: [], fields: [] };
        },
        release: vi.fn(),
      }),
    } as never;
    await skipOf(findStoredCandidates(recording, KEY, detector(), {}));
    const stored = sent.find((call) => call.text.includes('AS stored'));
    expect(stored?.values).toEqual([KEY]);
  });

  it('skips a result over the row cap', async () => {
    for (const id of [1, 2, 3]) await doodle(id, 'teal', '2026-03-01T00:00:00Z');
    const limits = { timeoutMs: 60_000, rowCap: 2 };
    expect((await skipOf(find(detector(), { limits }))).reason).toBe('row-cap');
    expect(await find(detector(), { limits: { ...limits, rowCap: 3 } })).toHaveLength(3);
  });

  it('survives a trailing line comment in the stored text', async () => {
    await doodle(1, 'teal', '2026-03-01T00:00:00Z');
    expect(await find(detector({ sql: `${TEAL_SQL} -- note` }))).toHaveLength(1);
  });

  it('reports a failed query by key and SQLSTATE, never its text', async () => {
    const skip = await skipOf(
      find(detector({ sql: `SELECT marker_7f3a AS "userId", now() AS "achievedAt"` }))
    );
    expect(skip.reason).toBe('query-error');
    expect(skip.code).toBe('42703');
    expect(`${skip.message}\n${skip.stack}`).not.toContain('marker_7f3a');
    expect(skip.cause).toBeUndefined();
  });

  describe('with a ClickHouse stage', () => {
    const chDetector = detector({
      clickhouse: 'SELECT id FROM ch_fixture',
      sql: `SELECT d."userId", min(d."drawnAt") AS "achievedAt"
        FROM "Doodle" d WHERE d.id = ANY($1::int[]) GROUP BY d."userId"`,
    });

    it('binds the ClickHouse ids as $1, under read-only limits', async () => {
      await doodle(1, 'red', '2026-03-01T00:00:00Z');
      await doodle(2, 'red', '2026-03-02T00:00:00Z');
      const [{ id }] = await q<{ id: number }>(`SELECT id FROM "Doodle" WHERE "userId" = 2`);
      const queryClickhouse = vi.fn<QueryClickhouse>(async () => [{ id }]);

      expect(
        await find(chDetector, { queryClickhouse, limits: { timeoutMs: 30_000, rowCap: 50 } })
      ).toEqual([{ userId: 2, milestoneKey: KEY, achievedAt: new Date('2026-03-02T00:00:00Z') }]);
      expect(queryClickhouse).toHaveBeenCalledWith('SELECT id FROM ch_fixture', {
        readonly: '1',
        max_execution_time: 30,
        max_result_rows: 50,
        result_overflow_mode: 'throw',
      });
    });

    it('merges repeated ids and skips a result over the row cap', async () => {
      const counting = detector({
        clickhouse: 'SELECT id FROM ch_fixture',
        sql: `SELECT cardinality($1::int[]) AS "userId", now() AS "achievedAt"`,
      });
      const queryClickhouse = async () => [{ id: 7 }, { id: 7 }, { id: 8 }];
      expect(await find(counting, { queryClickhouse })).toEqual([
        expect.objectContaining({ userId: 2 }),
      ]);
      const limits = { timeoutMs: 1000, rowCap: 2 };
      expect((await skipOf(find(counting, { queryClickhouse, limits }))).reason).toBe('row-cap');
    });

    it.each([
      ['an extra field', [{ id: 1, other: 2 }]],
      ['a string id', [{ id: '1' }]],
      ['a renamed field', [{ versionId: 1 }]],
    ])('skips ClickHouse rows with %s', async (_, rows) => {
      const skip = await skipOf(find(chDetector, { queryClickhouse: async () => rows }));
      expect(skip.reason).toBe('clickhouse-shape');
    });

    it('skips, without its message, when ClickHouse fails or is missing', async () => {
      const failing = await skipOf(
        find(chDetector, {
          queryClickhouse: async () => {
            throw new Error('Query: SELECT id FROM ch_fixture');
          },
        })
      );
      expect(failing.reason).toBe('clickhouse-error');
      expect(failing.message).not.toContain('ch_fixture');
      expect((await skipOf(find(chDetector))).reason).toBe('clickhouse-error');
    });
  });
});

describe('storedMilestoneGroups', () => {
  const valid = { type: 'query', sql: TEAL_SQL, dated: true, launchedAt: '2026-01-01T00:00:00Z' };

  it('builds one group per valid definition, and reports every other by key and reason', () => {
    const skips: StoredMilestoneSkip[] = [];
    const groups = storedMilestoneGroups(
      [
        { key: 'test:ok', detector: valid },
        { key: 'test:extra', detector: { ...valid, threshold: 5 } },
        { key: 'test:semicolon', detector: { ...valid, sql: `${TEAL_SQL};` } },
        { key: 'test:date', detector: { ...valid, launchedAt: 'soon' } },
        { key: 'test:kind', detector: { ...valid, type: 'cron' } },
        { key: 'test:null', detector: null },
        { key: 'create:models-1', detector: valid },
      ],
      { onSkip: (skip) => void skips.push(skip) }
    );
    expect(groups.map((g) => g.id)).toEqual(['stored:test:ok']);
    expect(skips.map((s) => [s.milestoneKey, s.reason])).toEqual([
      ['test:extra', 'invalid-definition'],
      ['test:semicolon', 'invalid-definition'],
      ['test:date', 'invalid-definition'],
      ['test:kind', 'unknown-detector'],
      ['test:null', 'unknown-detector'],
      ['create:models-1', 'key-collision'],
    ]);
    expect(skips.map((s) => s.message).join('\n')).not.toContain('Doodle');
  });

  // Otherwise an edited query would announce everyone it newly finds as tonight's news.
  it('fingerprints what the query grants, not when it launched', () => {
    const [a, b, c, d, e] = storedMilestoneGroups(
      [
        { key: 'test:a', detector: valid },
        { key: 'test:b', detector: { ...valid, sql: `${TEAL_SQL} HAVING true` } },
        { key: 'test:c', detector: { ...valid, launchedAt: '2026-06-01T00:00:00Z' } },
        { key: 'test:d', detector: { ...valid, dated: false } },
        { key: 'test:e', detector: { ...valid, clickhouse: 'SELECT 1 AS id' } },
      ],
      { onSkip: () => undefined }
    ).map((g) => g.fingerprint);
    expect(new Set([a, b, d, e]).size).toBe(4);
    expect(a).toBe(c);
  });

  it('loads definitions from the detector column', async () => {
    await q(`UPDATE "CreatorMilestone" SET detector = $2::jsonb WHERE key = $1`, [
      KEY,
      JSON.stringify(valid),
    ]);
    await q(
      `INSERT INTO "CreatorMilestone" (key, track, hidden, name) VALUES ('test:plain', 'hidden', true, 'Plain')`
    );
    const skips: StoredMilestoneSkip[] = [];
    const groups = await loadStoredMilestoneGroups(pool, {
      onSkip: (skip) => void skips.push(skip),
    });
    expect(groups.map((g) => g.keys)).toEqual([[KEY]]);
    expect(skips).toEqual([]);
  });
});

describe('a stored group through the grant runner', () => {
  const AFTER_LAUNCH = new Date('2026-04-01T00:00:00Z');

  async function grant(
    watermark: ActivityWatermark | null,
    {
      sql = TEAL_SQL,
      dated = true,
      silent = undefined as true | undefined,
      gated = false,
      audience = null as number[] | null,
    } = {}
  ) {
    const [group] = storedMilestoneGroups(
      [
        {
          key: KEY,
          detector: { type: 'query', sql, dated, silent, launchedAt: '2026-01-01T00:00:00Z' },
        },
      ],
      { onSkip: () => undefined }
    );
    const rows = new Map<string, ActivityWatermark>();
    if (watermark) rows.set(`creator-milestones:watermark:${group.watermarkId}`, watermark);
    const notified: MilestoneGrant[] = [];
    const result = await runActivityGroup(group, {
      readPg: pool,
      writePg: pool,
      store: { get: async (k) => rows.get(k) ?? null, set: async (k, w) => void rows.set(k, w) },
      gated,
      now: AFTER_LAUNCH,
      audienceAmong: async (ids) => new Set(ids.filter((id) => !audience || audience.includes(id))),
      notify: async (grants) => void notified.push(...grants),
    });
    return { result, notified, rows };
  }

  // A session zone other than UTC is what would shift a found moment on its way to the writer.
  beforeAll(async () => void (await holder.db.exec(`SET TIME ZONE 'Asia/Tokyo'`)));
  afterAll(async () => void (await holder.db.exec(`SET TIME ZONE 'UTC'`)));

  it('grants at the found moment, in UTC, and announces only what follows the last run', async () => {
    await doodle(1, 'teal', '2026-02-01T23:30:00Z');
    await doodle(2, 'teal', '2026-03-20T08:15:00Z');

    const first = await grant(null);
    expect(first.result).toMatchObject({ granted: 2, announced: 0 });

    await q(`DELETE FROM "UserCreatorMilestone"`);
    const [stored] = [...first.rows.values()];
    const second = await grant({ ...stored, at: new Date('2026-03-01T00:00:00Z').getTime() });
    expect(second.notified.map((g) => g.userId)).toEqual([2]);
    expect(
      await q(
        `SELECT "userId", to_char("achievedAt", 'YYYY-MM-DD HH24:MI') AS at
         FROM "UserCreatorMilestone" ORDER BY 1`
      )
    ).toEqual([
      { userId: 1, at: '2026-02-01 23:30' },
      { userId: 2, at: '2026-03-20 08:15' },
    ]);
  });

  it('announces nothing on the first run after its query changed', async () => {
    await doodle(2, 'teal', '2026-03-20T08:15:00Z');
    const first = await grant(null, { sql: `${TEAL_SQL} HAVING false` });
    expect(first.result).toMatchObject({ granted: 0 });
    const [stored] = [...first.rows.values()];

    const edited = await grant({ ...stored, at: new Date('2026-03-01T00:00:00Z').getTime() });
    expect(edited.result).toMatchObject({ granted: 1, announced: 0 });
  });

  const watermarkAfter = async (options: Parameters<typeof grant>[1]) => {
    const first = await grant(null, options);
    await q(`DELETE FROM "UserCreatorMilestone"`);
    const [stored] = [...first.rows.values()];
    return { ...stored, at: new Date('2026-03-01T00:00:00Z').getTime() };
  };

  // Grants wait on the flag while it gates them; a stored group must not reach past the audience.
  it('grants only the flag audience while grants are gated', async () => {
    await doodle(1, 'teal', '2026-02-01T00:00:00Z');
    await doodle(2, 'teal', '2026-02-01T00:00:00Z');
    const { result } = await grant(null, { gated: true, audience: [2] });
    expect(result).toMatchObject({ candidates: 2, audience: 1, granted: 1 });
    expect(await q(`SELECT "userId" FROM "UserCreatorMilestone"`)).toEqual([{ userId: 2 }]);
  });

  // An undated finding cannot be told from a backlog, so it announces only from a clean run.
  it('treats an undated definition as untimed', async () => {
    await doodle(1, 'teal', '2026-03-20T00:00:00Z');
    const sql = `SELECT DISTINCT d."userId", NULL::timestamptz AS "achievedAt"
      FROM "Doodle" d WHERE d.color = 'teal'`;
    const watermark = await watermarkAfter({ sql, dated: false });
    const { result } = await grant({ ...watermark, gated: true }, { sql, dated: false });
    expect(result).toMatchObject({ granted: 1, announced: 0 });
  });

  // The same gated watermark, dated: a dated finding is news whatever the gate did before.
  it('treats a dated definition as timed', async () => {
    await doodle(1, 'teal', '2026-03-20T00:00:00Z');
    const watermark = await watermarkAfter({});
    const { result } = await grant({ ...watermark, gated: true });
    expect(result).toMatchObject({ granted: 1, announced: 1 });
  });

  it('never announces a silent definition', async () => {
    await doodle(1, 'teal', '2026-03-20T00:00:00Z');
    const watermark = await watermarkAfter({ silent: true });
    const { result } = await grant(watermark, { silent: true });
    expect(result).toMatchObject({ granted: 1, announced: 0 });
  });
});
