import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

/**
 * A removal held through /api/mod/remove-images carries each image's open TOS reports onto its
 * ImageRemovalConfirmation row, which the moderator app's confirm actions (pinned there by
 * image-removal-confirmation.pglite.test.ts). The endpoint, the report read and the hold run for
 * real here; the report read through the Prisma raw query, the hold through Kysely, both on PGlite.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    images = vi.fn();
  },
}));

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../../packages/civitai-db-schema/prisma/migrations/20261031130000_image_removal_confirmation/migration.sql'
  ),
  'utf8'
);

const MODERATOR = 2;
const APPROVER = 4;
const HELD = 50; // approved on appeal, removed again for the overturned reason
const OTHER = 51; // the same batch, also held
const TOS_OPEN = 70;
const TOS_ACTIONED = 71;
const NSFW_OPEN = 72;
const TOS_PROCESSING = 73;
const OTHER_TOS_OPEN = 74;
const TOS_UNACTIONED = 75;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'CSAM');
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "bannedAt" TIMESTAMP(3));
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "userId" INTEGER, "url" TEXT, "needsReview" TEXT, "blockedFor" TEXT,
      "ingestion" TEXT, "metadata" JSONB, "nsfwLevel" INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE "Appeal" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "entityType" "EntityType" NOT NULL,
      "entityId" INTEGER NOT NULL, "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "appealMessage" TEXT NOT NULL DEFAULT 'please', "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
      "resolvedAt" TIMESTAMP(3), "resolvedBy" INTEGER, "resolvedReason" TEXT, "resolvedMessage" TEXT
    );
    CREATE TABLE "AppealDecisionRecord" ("appealId" INTEGER UNIQUE, "removalLabel" TEXT);
    CREATE TABLE "Report" (
      id int PRIMARY KEY, reason "ReportReason" NOT NULL, status "ReportStatus" NOT NULL,
      "userId" int NOT NULL DEFAULT 1, "statusSetAt" TIMESTAMP(3), "statusSetBy" int
    );
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
  `);
  await holder.db.exec(MIGRATION);
});

beforeEach(async () => {
  vi.clearAllMocks();
  void loggingMock;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(v as never[]));
    if (!/"Report"/.test(flat.text)) throw new Error(`unexpected raw read: ${flat.text}`);
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
  await holder.db.exec(`
    TRUNCATE "User", "Image", "Appeal", "AppealDecisionRecord", "Report", "ImageReport",
      "ImageRemovalConfirmation" RESTART IDENTITY;
    INSERT INTO "User" (id, username) VALUES (${MODERATOR}, 'mod'), (${APPROVER}, 'appr');
    INSERT INTO "Image" (id, "userId", url, ingestion, "nsfwLevel") VALUES
      (${HELD}, 9, 'u', 'Scanned', 4), (${OTHER}, 9, 'v', 'Scanned', 4);
    INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, "resolvedAt", "resolvedBy")
      VALUES (9, 'Image', ${HELD}, 'Approved', '2026-10-14 16:59:45', ${APPROVER}),
             (9, 'Image', ${OTHER}, 'Approved', '2026-10-14 16:59:45', ${APPROVER});
    INSERT INTO "AppealDecisionRecord" SELECT id, 'gore' FROM "Appeal";
    INSERT INTO "Report" (id, reason, status) VALUES
      (${TOS_OPEN}, 'TOSViolation', 'Pending'), (${TOS_ACTIONED}, 'TOSViolation', 'Actioned'),
      (${NSFW_OPEN}, 'NSFW', 'Pending'), (${TOS_PROCESSING}, 'TOSViolation', 'Processing'),
      (${OTHER_TOS_OPEN}, 'TOSViolation', 'Pending'), (${TOS_UNACTIONED}, 'TOSViolation', 'Unactioned');
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
      (${HELD}, ${TOS_OPEN}), (${HELD}, ${TOS_ACTIONED}), (${HELD}, ${NSFW_OPEN}),
      (${HELD}, ${TOS_PROCESSING}), (${HELD}, ${TOS_UNACTIONED}), (${OTHER}, ${OTHER_TOS_OPEN});
  `);
});

const { default: handler } = await import('~/server/api-routes/mod/remove-images');
const { getOpenImageReportIds, getOpenImageReportIdsByImage, updateImageReportStatusByReason } =
  await import('~/server/services/image.service');

const call = async (body: unknown) => {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
  await handler(
    {
      method: 'POST',
      url: '/api/mod/remove-images',
      query: {},
      headers: { 'x-webhook-token': 'test-webhook-token' },
      body,
    } as never,
    res as never
  );
  return res;
};

const confirmationReports = async () =>
  (
    await holder.db.query<{ imageId: number; reportIds: number[] }>(
      `SELECT "imageId", "reportIds" FROM "ImageRemovalConfirmation" ORDER BY "imageId"`
    )
  ).rows.map((r) => ({ imageId: r.imageId, reportIds: [...r.reportIds].sort() }));

describe('/api/mod/remove-images held removal', () => {
  it("stores each held image's open TOS reports for the confirm to action", async () => {
    await call({ imageIds: [HELD, OTHER], moderatorId: MODERATOR, violationType: 'gore' });

    const { rows } = await holder.db.query(
      `SELECT id FROM "Image" WHERE ingestion = 'Scanned' ORDER BY id`
    );
    expect(rows).toEqual([{ id: HELD }, { id: OTHER }]);
    expect(await confirmationReports()).toEqual([
      { imageId: HELD, reportIds: [TOS_OPEN, TOS_PROCESSING].sort() },
      { imageId: OTHER, reportIds: [OTHER_TOS_OPEN] },
    ]);
  });
});

describe('open image reports', () => {
  it('maps each image to its Pending or Processing TOS reports, leaving other reasons out', async () => {
    const byImage = await getOpenImageReportIdsByImage([HELD, OTHER, 99], 'TOSViolation' as never);

    expect([...byImage.keys()].sort()).toEqual([HELD, OTHER]);
    expect([...byImage.get(HELD)!].sort()).toEqual([TOS_OPEN, TOS_PROCESSING].sort());
    expect(byImage.get(OTHER)).toEqual([OTHER_TOS_OPEN]);
  });

  it('answers the single-image read with the same rule as the batch', async () => {
    for (const id of [HELD, OTHER, 99]) {
      const batch =
        (await getOpenImageReportIdsByImage([id], 'TOSViolation' as never)).get(id) ?? [];
      expect([...(await getOpenImageReportIds(id, 'TOSViolation' as never))].sort()).toEqual(
        [...batch].sort()
      );
    }
    expect([...(await getOpenImageReportIds(HELD, 'TOSViolation' as never))].sort()).toEqual(
      [TOS_OPEN, TOS_PROCESSING].sort()
    );
    expect(await getOpenImageReportIds(HELD, 'NSFW' as never)).toEqual([NSFW_OPEN]);
  });
});

// A direct (not held) removal actions the image's reports through this write; what it returns is
// whom setTosViolation rewards.
describe('a direct removal of an image', () => {
  it('actions only its open TOS reports, and returns only those to reward', async () => {
    const moved = await updateImageReportStatusByReason({
      id: HELD,
      reason: 'TOSViolation' as never,
      status: 'Actioned' as never,
      actorId: MODERATOR,
    });

    expect(moved.map((r) => r.id).sort()).toEqual([TOS_OPEN, TOS_PROCESSING].sort());
    const { rows } = await holder.db.query<{ id: number; status: string }>(
      `SELECT id, status FROM "Report" WHERE id = ANY($1::int[]) ORDER BY id`,
      [[TOS_ACTIONED, TOS_UNACTIONED]]
    );
    expect(rows).toEqual([
      { id: TOS_ACTIONED, status: 'Actioned' },
      { id: TOS_UNACTIONED, status: 'Unactioned' },
    ]);
  });
});
