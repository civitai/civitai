import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { CSAM_LINK_TABLES_SQL } from '../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';
import type * as ImageService from '~/server/services/image.service';

const { mockIngestImageById } = vi.hoisted(() => ({ mockIngestImageById: vi.fn() }));
const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
// The withheld rule the rescan asks runs for real, on the describe's own PGlite.
vi.mock('~/server/db/kyselyDb', () => {
  const db = pgliteKysely(() => holder.db);
  return { kyselyRead: db, kyselyWrite: db };
});

/** The tables `moderatorWithheldSql` reads, besides "Image". */
const WITHHELD_TABLES = `
  ${CSAM_LINK_TABLES_SQL}
  CREATE TABLE "Post" (id int PRIMARY KEY, metadata jsonb, "modelVersionId" int, "userId" int, "publishedAt" timestamp);
  CREATE TABLE "ModelVersion" (id int PRIMARY KEY, meta jsonb, "modelId" int);
  CREATE TABLE "Model" (id int PRIMARY KEY, meta jsonb);
  CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int PRIMARY KEY, url text, "userId" int, "csamReview" boolean);
  CREATE TABLE "BlockedImage" (hash bigint, reason text);
  CREATE TABLE "ScanLabelItem" (id int PRIMARY KEY, "imageId" int, "voidReason" text);
  CREATE TABLE "ScanLabelFlag" ("itemId" int, snapshot jsonb);
  CREATE TABLE "ScanLabelVote" ("itemId" int, reason text);
  CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, "textHash" TEXT, meta JSONB);
  CREATE TABLE "ImageCdnAccess" (url text PRIMARY KEY, state text NOT NULL, "deniedAt" timestamptz NOT NULL DEFAULT now(), "retractedAt" timestamptz DEFAULT now());
  CREATE TABLE "ImageCdnShopTakedown" (url text, "shopItemId" int, "userId" int);
`;

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  ingestImageById: mockIngestImageById,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/server/api-routes/admin/rescan-images';

const runRequest = async (imageIds: string) => {
  const req = { method: 'GET', query: { imageIds } } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  await handler(req, res);
  return res;
};

beforeEach(() => {
  mockIngestImageById.mockReset();
});

describe('/api/admin/rescan-images', () => {
  beforeAll(async () => {
    holder.db = new PGlite();
    await holder.db.exec(`
      CREATE TABLE "User" (id int PRIMARY KEY, meta jsonb);
      CREATE TABLE "Image" (id int PRIMARY KEY, url text, "userId" int, ingestion text, "blockedFor" text,
        "needsReview" text, "pHash" bigint, "postId" int);
      CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb, images jsonb, "reportSentAt" timestamp);
      CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
      ${WITHHELD_TABLES}`);
  });

  it('reports each id on its own when one is missing, instead of failing the batch', async () => {
    mockIngestImageById.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 2) throw new TRPCError({ code: 'NOT_FOUND' });
      if (id === 4) throw new Error('db timeout');
      return id !== 5;
    });

    const res = await runRequest('1,2,3,4,5');

    // Every id is attempted, including those after the missing one.
    expect(mockIngestImageById).toHaveBeenCalledTimes(5);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      imageIds: [1, 2, 3, 4, 5],
      submitted: [1, 3],
      notFound: [2],
      failed: [
        { id: 4, reason: 'db timeout' },
        { id: 5, reason: 'submit-rejected' },
      ],
    });
  });

  it('truncates a long failure reason', async () => {
    mockIngestImageById.mockRejectedValue(new Error('x'.repeat(1000)));

    const res = await runRequest('7');

    const body = res.json.mock.calls[0][0] as { failed: { reason: string }[] };
    expect(body.failed[0].reason.length).toBeLessThanOrEqual(200);
  });
});

describe('/api/admin/rescan-images rows', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    holder.db = db;
    await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3), meta jsonb);
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, ingestion "ImageIngestionStatus", "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0, "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "needsReview" text,
      minor boolean NOT NULL DEFAULT false, metadata jsonb, "scanJobs" jsonb, url text, type text NOT NULL DEFAULT 'image',
      width int, height int, meta jsonb, "scanRequestedAt" timestamp(3), "pHash" bigint, "postId" int);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp(3), "archivedAt" timestamp(3));
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
    ${WITHHELD_TABLES}
    INSERT INTO "User" (id) VALUES (20), (22);`);
  });

  beforeEach(async () => {
    await db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", minor, url) VALUES
      (101, 20, 'Blocked', 'moderated', 32, false, 'https://example.invalid/101.jpeg'),
      (102, 20, 'Blocked', 'moderated', 32, true, 'https://example.invalid/102.jpeg'),
      (103, 22, 'Blocked', 'CSAM', 32, false, 'https://example.invalid/103.jpeg');`);
    dbMock.dbWrite.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const flat = Prisma.sql(strings, ...(values as never[]));
      return (await db.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
    }) as never);
    mockIngestImageById.mockResolvedValue(true);
  });

  const states = async () =>
    (
      await db.query<{ id: number; ingestion: string }>(
        'SELECT id, ingestion FROM "Image" ORDER BY id'
      )
    ).rows.map((r) => [r.id, r.ingestion]);

  it('case 1', async () => {
    const res = await runRequest('101,102,103');
    expect(await states()).toEqual([
      [101, 'Rescan'],
      [102, 'Blocked'],
      [103, 'Blocked'],
    ]);
    // 103 is withheld from a caller without the grant, and the token carries none.
    expect(mockIngestImageById.mock.calls.map(([a]) => (a as { id: number }).id).sort()).toEqual([
      101, 102,
    ]);
    expect(res.json.mock.calls[0][0].failed).toEqual([
      { id: 103, reason: 'Not ruled on here. Ask a lead. Nothing was changed: 103.' },
    ]);
    const updateOrder = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0];
    expect(Math.min(...mockIngestImageById.mock.invocationCallOrder)).toBeGreaterThan(updateOrder);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
