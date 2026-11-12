import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real hold predicate has its own suite; here a held owner is one listed in "Held".
vi.mock('~/server/services/legal-hold.service', () => ({
  ownerHeldSql: (owner: Prisma.Sql) => Prisma.sql`(${owner} IN (SELECT "userId" FROM "Held"))`,
}));

import { apply, dryRun, parseArgs, type Deps } from '../oneoffs/backfill-deleted-model-versions';

const LIVE = 1;
const DELETED_OWNER = 2;
const HELD = 3;
const OLD = '2026-01-01 00:00:00';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM
      ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation',
       'GatherInterest', 'Deleted');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3));
    CREATE TABLE "Held" ("userId" int);
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status "ModelStatus" NOT NULL,
      "deletedBy" int, meta jsonb
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status "ModelStatus" NOT NULL,
      "updatedAt" timestamp(3) NOT NULL
    );
  `);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "User", "Held", "Model", "ModelVersion";
    INSERT INTO "User" VALUES (${LIVE}, NULL), (${DELETED_OWNER}, now()), (${HELD}, now());
    INSERT INTO "Held" VALUES (${HELD});
    INSERT INTO "Model" VALUES
      (10, ${DELETED_OWNER}, 'Deleted', NULL, NULL),
      (11, ${LIVE}, 'Deleted', NULL, NULL),
      (12, ${LIVE}, 'Published', NULL, NULL),
      (13, ${HELD}, 'Deleted', NULL, NULL);
    INSERT INTO "ModelVersion" VALUES
      (1, 10, 'Published', '${OLD}'),
      (2, 10, 'Scheduled', '${OLD}'),
      (3, 10, 'Draft', '${OLD}'),
      (4, 11, 'Published', '${OLD}'),
      (5, 12, 'Published', '${OLD}'),
      (6, 13, 'Published', '${OLD}');
  `);
});

const statuses = async () =>
  Object.fromEntries(
    (
      await db.query<{ id: number; status: string }>(
        `SELECT id, status FROM "ModelVersion" ORDER BY id`
      )
    ).rows.map((r) => [r.id, r.status])
  );

function makeDeps(overrides: Partial<Deps> = {}) {
  const calls: string[] = [];
  const deps: Deps = {
    query: async <T>(sql: Prisma.Sql) => (await db.query<T>(sql.text, sql.values)).rows,
    bustVersions: vi.fn(async (ids: number[]) => void calls.push(`versions:${ids.join(',')}`)),
    bustOrchestrator: vi.fn(async (ids: number[]) => void calls.push(`orch:${ids.join(',')}`)),
    bustModels: vi.fn(async (ids: number[]) => void calls.push(`models:${ids.join(',')}`)),
    sleep: vi.fn(async (ms: number) => void calls.push(`sleep:${ms}`)),
    log: vi.fn(),
    writePending: vi.fn(() => '/tmp/pending.json'),
    ...overrides,
  };
  return { deps, calls };
}

describe('backfill-deleted-model-versions', () => {
  it('flips Published and Scheduled versions of Deleted models, skipping held owners', async () => {
    const { deps } = makeDeps();
    const options = parseArgs(['--apply', '--chunk', '2', '--pause-ms', '5']);

    expect(await apply(options, deps)).toBe(3);

    expect(await statuses()).toEqual({
      1: 'Deleted',
      2: 'Deleted',
      3: 'Draft',
      4: 'Deleted',
      5: 'Published',
      6: 'Published',
    });
    const updatedAt = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ModelVersion" WHERE "updatedAt" <> '${OLD}'`
    );
    expect(updatedAt.rows[0].n).toBe(0);
  });

  it('busts each chunk: versions, then the orchestrator, then the models, pausing between chunks', async () => {
    const { deps, calls } = makeDeps();
    await apply(parseArgs(['--apply', '--chunk', '2', '--pause-ms', '5']), deps);

    expect(calls).toEqual([
      'versions:1,2',
      'orch:1,2',
      'models:10',
      'sleep:5',
      'versions:4',
      'orch:4',
      'models:11',
      'sleep:5',
    ]);
  });

  it('re-checks the hold in the UPDATE, so a hold placed after the select still stops it', async () => {
    let selects = 0;
    const { deps } = makeDeps({
      query: async <T>(sql: Prisma.Sql) => {
        const rows = (await db.query<T>(sql.text, sql.values)).rows;
        if (sql.text.trimStart().startsWith('SELECT') && selects++ === 0)
          await db.exec(`INSERT INTO "Held" VALUES (${DELETED_OWNER})`);
        return rows;
      },
    });

    await apply(parseArgs(['--apply']), deps);

    expect(await statuses()).toMatchObject({ 1: 'Published', 2: 'Scheduled', 4: 'Deleted' });
  });

  it('stops on the first orchestrator error and records the versions it did not bust', async () => {
    const { deps } = makeDeps({
      bustOrchestrator: vi.fn(async () => {
        throw new Error('orchestrator 503');
      }),
    });

    await expect(apply(parseArgs(['--apply', '--chunk', '2']), deps)).rejects.toThrow(
      'orchestrator 503'
    );

    expect(deps.writePending).toHaveBeenCalledWith({ versionIds: [1, 2], modelIds: [10] });
    expect(deps.bustModels).not.toHaveBeenCalled();
    // The next chunk is never flipped.
    expect((await statuses())[4]).toBe('Published');
  });

  it('sends the orchestrator at most 100 versions per call, with a pause between calls', async () => {
    const values = Array.from({ length: 150 }, (_, i) => `(${100 + i}, 10, 'Published', '${OLD}')`);
    await db.exec(`INSERT INTO "ModelVersion" VALUES ${values.join(', ')}`);
    const { deps, calls } = makeDeps();

    await apply(parseArgs(['--apply', '--chunk', '2000', '--pause-ms', '7']), deps);

    const orch = vi.mocked(deps.bustOrchestrator).mock.calls.map(([ids]) => ids.length);
    expect(orch).toEqual([100, 53]);
    const [first, second] = calls.flatMap((c, i) => (c.startsWith('orch:') ? [i] : []));
    expect(calls.slice(first, second)).toContain('sleep:7');
  });

  it('dry run writes nothing and reports the live-owner models on their own line', async () => {
    const { deps } = makeDeps();

    await dryRun(deps);

    expect((await statuses())[1]).toBe('Published');
    const lines = vi.mocked(deps.log).mock.calls.map(([line]) => line);
    expect(lines).toContain('  owner not deleted, account-delete: 1 models, 1 versions');
    expect(lines).toContain('  Published: 2 to flip, 1 held');
  });

  it('refuses a chunk over 2000', () => {
    expect(() => parseArgs(['--chunk', '2001'])).toThrow('--chunk must be 1-2000');
  });
});
