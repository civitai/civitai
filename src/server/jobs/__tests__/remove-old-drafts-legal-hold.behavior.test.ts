import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * remove-old-drafts against the real hold marker: the DELETE runs on a Postgres stand-in with the
 * evidence-hold migration applied, so the hold predicate inside it is what decides.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockDeregisterBatch } = vi.hoisted(() => ({
  mockDeregisterBatch: vi.fn(async (_versionIds: number[]) => ({ deleted: 0 })),
}));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: mockDeregisterBatch }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';

const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

// One owner per way of being held, and one who is not.
const MARKED_OWNER = 1; // a hold marker
const REPORTED_OWNER = 3; // named on a report not yet sent: no marker row exists for them
const REVIEW_OWNER = 4; // an image awaiting CSAM review: the account hold's image leg
const FREE_OWNER = 2;
const MODELS = [
  { id: 10, userId: MARKED_OWNER, versionId: 100 },
  { id: 30, userId: REPORTED_OWNER, versionId: 300 },
  { id: 40, userId: PLACEHOLDER_OWNER_ID, versionId: 400 },
  { id: 50, userId: REVIEW_OWNER, versionId: 500 },
  { id: 20, userId: FREE_OWNER, versionId: 200 },
];
const FREE_MODEL = 20;
const FREE_VERSION = 200;
const KEPT_MODELS = [10, 30, 40, 50];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
      "blockedFor" text, metadata jsonb, "updatedAt" timestamp(3)
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, title text, detail text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "publishedAt" timestamp(3),
      "modelVersionId" int, "collectionId" int, metadata jsonb
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "Thread" (
        id serial PRIMARY KEY, "modelId" int, "reviewId" int, "postId" int, "imageId" int,
        "parentThreadId" int, "rootThreadId" int, "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE "CommentV2" (id serial PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL);
      CREATE TABLE "Comment" (id serial PRIMARY KEY, "userId" int NOT NULL, "modelId" int, "parentId" int);
      CREATE TABLE "ResourceReview" (id serial PRIMARY KEY, "modelId" int);
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL REFERENCES "Model"(id) ON DELETE CASCADE,
      "createdAt" timestamp(3) NOT NULL, "updatedAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "ModelFile" (
      id serial PRIMARY KEY,
      "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE,
      "createdAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
    );
  `);
  await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  await db.exec(`
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED_OWNER}, 'manual', 'review');
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED_OWNER});
    INSERT INTO "Image" (id, "userId", "needsReview") VALUES (9001, ${REVIEW_OWNER}, 'csam');
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    DELETE FROM "Model";
    INSERT INTO "Model" (id, "userId") VALUES ${MODELS.map((m) => `(${m.id}, ${m.userId})`).join(
      ', '
    )};
    INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES ${MODELS.map(
      (m) => `(${m.versionId}, ${m.id}, now() - interval '200 days', now() - interval '200 days')`
    ).join(', ')};
  `);
  // The replica SELECT names every model as a candidate; everything on the primary runs on the
  // stand-in.
  dbMock.dbRead.$queryRaw.mockResolvedValue(MODELS.map(({ id, userId }) => ({ id, userId })));
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);
});

const remainingModels = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "Model" ORDER BY id`)).rows.map((r) => r.id);
const axiomEvents = (message: string) =>
  loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as Record<string, unknown>)
    .filter((arg) => arg.message === message);

describe('remove-old-drafts under a legal hold', () => {
  it("keeps every held owner's model and its file registrations, and deletes the rest", async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(await remainingModels()).toEqual(KEPT_MODELS);
    // Deregistering a kept model's versions would drop its files out of the quarantine allowlist.
    expect(mockDeregisterBatch.mock.calls).toEqual([[[FREE_VERSION]]]);
    expect(axiomEvents('Removed old draft models')).toEqual([
      expect.objectContaining({ modelIds: [FREE_MODEL] }),
    ]);
    expect(axiomEvents('Kept old draft models of owners under a legal hold')).toEqual([
      expect.objectContaining({ modelIds: KEPT_MODELS }),
    ]);
  });
});
