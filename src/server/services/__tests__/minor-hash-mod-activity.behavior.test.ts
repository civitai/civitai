import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// What the minor-hash reads make of the moderation log's `setMinor` rows, against real Postgres:
// the log is append-only, so a model can carry several, and a moderator's edit-form flag writes one
// through the same `trackModActivity` as every other moderator flag.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, lastRows: [] as unknown[] }));

// Inlined as literals: the statements bind JSON keys untyped (`meta ? $1`), which the real driver
// sends as text but PGlite refuses to infer.
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(', ')}]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(strings: TemplateStringsArray, values: unknown[]) {
  const flat = Prisma.sql(strings, ...(values as never[]));
  const text = flat.text.replace(/\$(\d+)/g, (_, i: string) => literal(flat.values[Number(i) - 1]));
  return holder.db.query(text);
}

dbMock.dbWrite.$executeRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, values)).affectedRows ?? 0) as never
);
dbMock.dbRead.$queryRaw.mockImplementation((async (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  holder.lastRows = (await run(strings, values)).rows;
  return holder.lastRows;
}) as never);

const { getMinorHashMatchDetail, rollbackMinorHashAutoFlags } = await import(
  '~/server/services/minor-hash.service'
);
const { trackModActivity } = await import('~/server/services/moderator.service');

const MODERATOR_ID = 7;
const AUTO_FLAGGED = 1;

beforeEach(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id INTEGER PRIMARY KEY, username TEXT, "createdAt" TIMESTAMP(3) DEFAULT now());
    CREATE TABLE "Model" (
      id INTEGER PRIMARY KEY, "userId" INTEGER, minor BOOLEAN NOT NULL DEFAULT false, meta JSONB,
      status TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP(3) DEFAULT now(),
      "deletedAt" TIMESTAMP(3)
    );
    CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, "modelId" INTEGER);
    CREATE TABLE "Post" (id INTEGER PRIMARY KEY, "modelVersionId" INTEGER);
    CREATE TABLE "Image" (id INTEGER PRIMARY KEY, "postId" INTEGER, index INTEGER, url TEXT, type TEXT);
    CREATE TABLE "ModActivity" (
      id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL, "entityType" TEXT,
      "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
    );
  `);
});

afterEach(async () => {
  await holder.db.close();
});

describe('blanket rollback and a moderator flag from the edit form', () => {
  async function seedAutoFlag(snapshotAt: string) {
    await holder.db.query(`INSERT INTO "Model" (id, minor, meta) VALUES ($1, true, $2::jsonb)`, [
      AUTO_FLAGGED,
      JSON.stringify({ minorFlagSnapshot: { source: 'auto', at: snapshotAt } }),
    ]);
  }

  // The row model.upsert writes for a moderator turning minor on, through the same writer.
  const formSetMinor = () =>
    trackModActivity(MODERATOR_ID, {
      entityType: 'model',
      entityId: AUTO_FLAGGED,
      activity: 'setMinor',
    });

  it('leaves an auto flag a moderator re-flagged after it', async () => {
    await seedAutoFlag('2020-01-01T00:00:00Z');
    await formSetMinor();

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 10 });

    expect(report).toMatchObject({ candidates: 0, skipped: 1 });
  });

  it('control: rolls back an auto flag no moderator touched', async () => {
    await seedAutoFlag('2020-01-01T00:00:00Z');

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 10 });

    expect(report).toMatchObject({ candidates: 1, skipped: 0 });
  });

  it('control: rolls back an auto flag that came after the moderator flag', async () => {
    await formSetMinor();
    await seedAutoFlag('2999-01-01T00:00:00Z');

    const report = await rollbackMinorHashAutoFlags({ dryRun: true, limit: 10 });

    expect(report).toMatchObject({ candidates: 1, skipped: 0 });
  });
});

describe('getMinorHashMatchDetail on a seed flagged more than once', () => {
  const MATCH = 1;
  const SEED = 2;

  async function seedFlags(order: 'oldest first' | 'latest first') {
    await holder.db.exec(`
      INSERT INTO "User" (id, username) VALUES (1, 'uploader'), (2, 'first-mod'), (3, 'latest-mod');
      INSERT INTO "Model" (id, "userId") VALUES (${MATCH}, 1), (${SEED}, 1);
    `);
    const flags = [
      [2, '2026-01-01T00:00:00Z'],
      [3, '2026-06-01T00:00:00Z'],
    ] as const;
    for (const [userId, at] of order === 'oldest first' ? flags : [...flags].reverse())
      await holder.db.query(
        `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
         VALUES ($1, 'setMinor', 'model', $2, $3)`,
        [userId, SEED, at]
      );
  }

  // Both insertion orders: an unordered join happens to name the right moderator in one of them.
  it.each(['oldest first', 'latest first'] as const)(
    'returns one row naming the latest flag (%s)',
    async (order) => {
      await seedFlags(order);

      const detail = await getMinorHashMatchDetail({ modelId: MATCH, minorModelId: SEED });

      expect(holder.lastRows).toHaveLength(1);
      expect(detail?.minorFlaggedByUsername).toBe('latest-mod');
    }
  );

  it('still returns the model when nothing seeded the flag', async () => {
    await seedFlags('oldest first');

    const detail = await getMinorHashMatchDetail({ modelId: MATCH, minorModelId: null });

    expect(holder.lastRows).toHaveLength(1);
    expect(detail?.minorFlaggedByUsername).toBeNull();
  });
});
