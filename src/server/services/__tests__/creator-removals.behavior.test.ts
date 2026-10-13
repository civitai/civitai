import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, chQuery: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: { query: holder.chQuery },
}));

type Raw = ReturnType<typeof pgliteRaw>;
const toPglite = ((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never;
dbMock.dbRead.$queryRaw.mockImplementation(toPglite);
dbMock.dbWrite.$queryRaw.mockImplementation(toPglite);

const { getMyRemovedImages } = await import('~/server/services/creator-removed-images.service');
const { getReportAgainstScore } = await import('~/server/jobs/update-user-score');
const { removalsQuery } = await import('~/server/services/creator-removals.service');

const OWNER = 42;
const OTHER = 43; // whose only removal was reversed since the last run
const REMOVED_AT = 1_700_000_000;
const LAST_RUN = REMOVED_AT + 86_400;
const at = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 23).replace('T', ' ');

// One owner, four removed images, as ClickHouse groups them (latest removal per image).
const RESTORED = 1; // removal reversed by an approved appeal
const STILL_REMOVED = 2; // no appeal
const REJECTED = 3; // appeal rejected
const REMOVED_AGAIN = 4; // approved, then removed again later
const removals = [
  { ownerId: OWNER, imageId: REMOVED_AGAIN, removedAt: REMOVED_AT + 7200 },
  { ownerId: OWNER, imageId: RESTORED, removedAt: REMOVED_AT },
  { ownerId: OWNER, imageId: STILL_REMOVED, removedAt: REMOVED_AT },
  { ownerId: OWNER, imageId: REJECTED, removedAt: REMOVED_AT },
  { ownerId: OTHER, imageId: 5, removedAt: REMOVED_AT },
];
const ownRemovals = removals.filter((r) => r.ownerId === OWNER);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL, "url" text NOT NULL DEFAULT '',
      "blockedFor" text, "needsReview" text
    );
    CREATE TABLE "Appeal" (
      "id" serial PRIMARY KEY, "userId" integer NOT NULL, "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp(3)
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Report" ("id" serial PRIMARY KEY, "reason" text NOT NULL);
    CREATE TABLE "UserReport" ("userId" integer NOT NULL, "reportId" integer NOT NULL);
  `);
});

beforeEach(async () => {
  await holder.db.exec(`TRUNCATE "Image", "Appeal"`);
  await holder.db.exec(`
    INSERT INTO "Image" (id, "userId", "blockedFor") VALUES
      (${RESTORED}, ${OWNER}, NULL),
      (${STILL_REMOVED}, ${OWNER}, 'moderated'),
      (${REJECTED}, ${OWNER}, 'moderated'),
      (${REMOVED_AGAIN}, ${OWNER}, 'moderated'),
      (5, ${OTHER}, NULL);
    INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "resolvedAt") VALUES
      (${OWNER}, 'Image', ${RESTORED}, 'Approved', '${at(REMOVED_AT + 3600)}'),
      (${OWNER}, 'Image', ${REJECTED}, 'Rejected', '${at(REMOVED_AT + 3600)}'),
      (${OWNER}, 'Image', ${REMOVED_AGAIN}, 'Approved', '${at(REMOVED_AT + 3600)}'),
      (${OTHER}, 'Image', 5, 'Approved', '${at(LAST_RUN + 60)}');
  `);
  holder.chQuery.mockReset();
  holder.chQuery.mockResolvedValue({ json: async () => ownRemovals });
});

describe('the removed-images list', () => {
  it('leaves out a removal an approved appeal reversed, and keeps every other one', async () => {
    const result = await getMyRemovedImages(OWNER);

    expect(result.items.map((i) => i.imageId)).toEqual([REMOVED_AGAIN, STILL_REMOVED, REJECTED]);
    expect(result.total).toBe(3);
  });
});

/**
 * Stands in for ClickHouse: OWNER has an event since the last run, and `removalsQuery` is answered from
 * `removals` (its restore-event half is not modelled; the text pin below covers it).
 */
function fakeClickhouse() {
  const $query = vi.fn(async (query: TemplateStringsArray | string) => {
    const sql = typeof query === 'string' ? query : query.join('?');
    if (sql === removalsQuery(sql.match(/AND (ownerId IN \([\d,]+\))/)?.[1] ?? '')) {
      const owners = sql
        .match(/ownerId IN \(([\d,]+)\)/)![1]
        .split(',')
        .map(Number);
      return removals.filter((r) => owners.includes(r.ownerId));
    }
    if (sql.includes('imageId IN (')) {
      const ids = sql
        .match(/imageId IN \(([\d,]+)\)/)![1]
        .split(',')
        .map(Number);
      return [
        ...new Set(removals.filter((r) => ids.includes(r.imageId)).map((r) => r.ownerId)),
      ].map((ownerId) => ({ ownerId }));
    }
    if (sql.includes('time > ?')) return [{ ownerId: OWNER }];
    throw new Error(`unexpected query: ${sql}`);
  });
  return { $query };
}

async function scoreRun() {
  const scores = new Map<number, number>();
  await getReportAgainstScore({
    ch: fakeClickhouse() as never,
    lastUpdate: new Date(LAST_RUN * 1000),
    scoreMultipliers: { reportsAgainst: -1000 } as never,
    setScore: (id, category, score) => {
      expect(category).toBe('reportsAgainst');
      scores.set(id, score);
    },
  });
  return scores;
}

describe('the Removed content score', () => {
  it('counts every removal but the one an approved appeal reversed', async () => {
    // Still removed, appeal rejected, and removed again after an approval: three of the four.
    expect((await scoreRun()).get(OWNER)).toBe(-3000);
  });

  it('re-scores, to zero, an owner whose appeal was approved since the last run', async () => {
    expect((await scoreRun()).get(OTHER)).toBe(0);
  });

  it('matches the list for the same owner', async () => {
    const listed = await getMyRemovedImages(OWNER);

    expect(Math.abs((await scoreRun()).get(OWNER)!)).toBe(listed.total * 1000);
  });

  it('drops a removal a later restore event reversed, in ClickHouse', () => {
    expect(removalsQuery('x')).toContain(
      "HAVING maxIf(time, type = 'DeleteTOS') > maxIf(time, type = 'Restore')"
    );
  });
});
