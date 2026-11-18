import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDeleteImages } = vi.hoisted(() => ({ mockDeleteImages: vi.fn() }));

// Hand-listed rather than spread from the real module, which builds module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImages: mockDeleteImages }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { imageDeletes, queuedImageDeleteGuard } from '~/server/jobs/image-deletes';

vi.setConfig({ hookTimeout: 60_000 });

const FAILING_IDS = new Set([3, 9]);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageDelete', 'ImageStorageDelete');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  // Returns the ids it deleted: every one but an even id, which reads as already gone or kept.
  mockDeleteImages.mockImplementation(async (ids: number[]) => {
    if (ids.some((id) => FAILING_IDS.has(id))) throw new Error('delete failed');
    return ids.filter((id) => id % 2).map((id) => ({ id }));
  });
  await db.exec(`
    TRUNCATE "JobQueue";
    INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt") VALUES
      (1, 'Image', 'ImageDelete', '{}', now() - interval '10 minutes'),
      (2, 'Image', 'ImageDelete', '{}', now() - interval '10 minutes'),
      (5, 'Image', 'ImageDelete', '{"moderatorDelete": true}', now() - interval '10 minutes'),
      -- Just queued: taken at once.
      (7, 'Image', 'ImageDelete', '{}', now()),
      -- Another queue's row for a queued image.
      (1, 'Image', 'ImageStorageDelete', '{"url": "a"}', now() - interval '10 minutes');
  `);
});

const queueOld = (id: number, data: Record<string, unknown>, minutes = 10) =>
  db.query(
    `INSERT INTO "JobQueue" ("entityId", "entityType", type, data, "createdAt")
     VALUES ($1, 'Image', 'ImageDelete', $2, now() - $3::int * interval '1 minute')`,
    [id, JSON.stringify(data), minutes]
  );

const runJob = () =>
  imageDeletes.run({} as Parameters<typeof imageDeletes.run>[0]).result as Promise<
    Record<string, unknown>
  >;

const remaining = async () =>
  (
    await db.query<{ entityId: number; type: string; data: unknown }>(
      `SELECT "entityId", type::text AS type, data FROM "JobQueue" ORDER BY "entityId", type`
    )
  ).rows.map(({ entityId, type, data }) => ({ entityId, type, data }));

// As the system, exactly as queued, unless the owner is held.
const how = (moderatorDelete: boolean) => ({
  actor: { system: 'image-deletes' },
  onlyWhere: expect.objectContaining({ sql: queuedImageDeleteGuard().sql }),
  moderatorDelete,
});

describe('image-deletes', () => {
  it('deletes each row the way it was queued, and clears it whether or not a row came back', async () => {
    expect(await runJob()).toEqual({ queued: 4, deleted: 3, failed: 0 });

    expect(mockDeleteImages.mock.calls).toEqual([
      [[1, 2, 7], how(false)],
      [[5], how(true)],
    ]);
    expect(await remaining()).toEqual([
      { entityId: 1, type: 'ImageStorageDelete', data: { url: 'a' } },
    ]);
  });

  it('keeps going past an image that fails, which stays queued and is marked attempted', async () => {
    await queueOld(3, {});

    expect(await runJob()).toMatchObject({ queued: 5, failed: 1 });

    expect(await remaining()).toEqual([
      { entityId: 1, type: 'ImageStorageDelete', data: { url: 'a' } },
      { entityId: 3, type: 'ImageDelete', data: { attempted: true } },
    ]);
  });

  it("retries a failing moderator's image one at a time still as a moderator's delete", async () => {
    await queueOld(9, { moderatorDelete: true });

    expect(await runJob()).toMatchObject({ failed: 1 });

    expect(mockDeleteImages.mock.calls.slice(1)).toEqual([
      [[5, 9], how(true)],
      [[5], how(true)],
      [[9], how(true)],
    ]);
    expect((await remaining()).find((row) => row.entityId === 9)?.data).toEqual({
      moderatorDelete: true,
      attempted: true,
    });
  });

  it('takes a retry after the first attempts, however old', async () => {
    await queueOld(11, { attempted: true }, 30);

    await runJob();

    expect(mockDeleteImages.mock.calls[0][0]).toEqual([1, 2, 7, 11]);
  });
});

// The guard itself, against the real hold migration.
describe('queuedImageDeleteGuard', () => {
  const MARKED = 71; // a hold marker
  const SECONDARY = 72; // the secondary user on someone else's pending report
  const REVIEWED = 73; // an image awaiting CSAM review
  const REPORTED = 74; // a safety report of their own, sent and closed
  const FREE = 75;
  let hold: PGlite;

  beforeAll(async () => {
    hold = new PGlite();
    await hold.exec(`
      CREATE TABLE "Image" (
        id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "needsReview" text,
        "blockedFor" text, metadata jsonb
      );
      CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "CsamReport" (
        id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
        images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
      );
    `);
    await hold.exec(
      readFileSync(
        path.resolve(
          __dirname,
          '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
        ),
        'utf8'
      )
    );
    await hold.exec(`
      INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED}, 'manual', 'review');
      INSERT INTO "CsamReport" ("userId", details) VALUES (1, '{"secondaryUserId": ${SECONDARY}}');
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES (${REPORTED}, now(), now());
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (9001, ${REVIEWED}, 'csam');
    `);
  });
  afterAll(() => hold.close());

  /** Whether the guard lets a delete take an image of `ownerId`'s. */
  const deletable = async (ownerId: number) => {
    const id = ownerId + 1000;
    await hold.query(`INSERT INTO "Image" (id, "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      id,
      ownerId,
    ]);
    const guard = Prisma.sql`SELECT id FROM "Image" WHERE id = ${id} AND ${queuedImageDeleteGuard()}`;
    return (await hold.query(guard.text, guard.values as unknown[])).rows.length > 0;
  };

  it.each([
    ['being the placeholder owner', -1],
    ['a hold marker', MARKED],
    ["the secondary user on another's report", SECONDARY],
    ['an image awaiting CSAM review', REVIEWED],
    ['a safety report of their own', REPORTED],
  ])('keeps the image of an owner held by %s', async (_, ownerId) => {
    expect(await deletable(ownerId)).toBe(false);
  });

  it('lets the image of an owner with no hold go', async () => {
    expect(await deletable(FREE)).toBe(true);
  });
});
