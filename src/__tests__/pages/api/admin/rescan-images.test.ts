import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';

const { mockIngestImageById } = vi.hoisted(() => ({ mockIngestImageById: vi.fn() }));

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
    await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3), "deletedAt" timestamp(3));
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text, "createdAt" timestamp(3) DEFAULT now());
    CREATE TABLE "Image" (id int PRIMARY KEY, "userId" int NOT NULL, ingestion "ImageIngestionStatus", "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0, "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "needsReview" text,
      minor boolean NOT NULL DEFAULT false, metadata jsonb, "scanJobs" jsonb, url text, type text NOT NULL DEFAULT 'image',
      width int, height int, meta jsonb, "scanRequestedAt" timestamp(3));
    CREATE TABLE "EvidenceHeldUser" ("userId" int PRIMARY KEY);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp(3), "archivedAt" timestamp(3));
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean NOT NULL DEFAULT false);
    INSERT INTO "User" (id) VALUES (20), (21), (22);
    INSERT INTO "EvidenceHeldUser" VALUES (21);`);
  });

  beforeEach(async () => {
    await db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor", "nsfwLevel", minor, url) VALUES
      (101, 20, 'Blocked', 'moderated', 32, false, 'https://example.invalid/101.jpeg'),
      (102, 20, 'Blocked', 'moderated', 32, true, 'https://example.invalid/102.jpeg'),
      (103, 22, 'Blocked', 'CSAM', 32, false, 'https://example.invalid/103.jpeg'),
      (104, 21, 'Blocked', 'moderated', 32, false, 'https://example.invalid/104.jpeg');`);
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
    const res = await runRequest('101,102,103,104');
    expect(await states()).toEqual([
      [101, 'Rescan'],
      [102, 'Blocked'],
      [103, 'Blocked'],
      [104, 'Blocked'],
    ]);
    expect(mockIngestImageById.mock.calls.map(([a]) => (a as { id: number }).id).sort()).toEqual([
      101, 102, 103, 104,
    ]);
    const updateOrder = dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0];
    expect(Math.min(...mockIngestImageById.mock.invocationCallOrder)).toBeGreaterThan(updateOrder);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
