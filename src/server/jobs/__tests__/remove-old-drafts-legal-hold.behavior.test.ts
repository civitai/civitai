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

const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

const HELD_OWNER = 1;
const FREE_OWNER = 2;
const HELD_MODEL = 10;
const FREE_MODEL = 20;
const HELD_VERSION = 100;
const FREE_VERSION = 200;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL, "blockedFor" text, metadata jsonb, "updatedAt" timestamp(3)
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, title text, detail text,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(), "publishedAt" timestamp(3),
      "modelVersionId" int, "collectionId" int, metadata jsonb
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
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
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${HELD_OWNER}, 'manual', 'review');
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(`
    DELETE FROM "Model";
    INSERT INTO "Model" (id, "userId") VALUES (${HELD_MODEL}, ${HELD_OWNER}), (${FREE_MODEL}, ${FREE_OWNER});
    INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES
      (${HELD_VERSION}, ${HELD_MODEL}, now() - interval '200 days', now() - interval '200 days'),
      (${FREE_VERSION}, ${FREE_MODEL}, now() - interval '200 days', now() - interval '200 days');
  `);
  // The replica SELECT names both as candidates; everything on the primary runs on the stand-in.
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { id: HELD_MODEL, userId: HELD_OWNER },
    { id: FREE_MODEL, userId: FREE_OWNER },
  ]);
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

describe('remove-old-drafts under a legal hold', () => {
  it("keeps a held owner's model and its file registrations, and deletes the rest", async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(await remainingModels()).toEqual([HELD_MODEL]);
    // Deregistering the kept model's versions would drop its files out of the quarantine allowlist.
    expect(mockDeregisterBatch.mock.calls).toEqual([[[FREE_VERSION]]]);
    const removed = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as Record<string, unknown>)
      .filter((arg) => arg.message === 'Removed old draft models');
    expect(removed).toEqual([expect.objectContaining({ modelIds: [FREE_MODEL] })]);
  });
});
