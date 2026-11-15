import { PGlite } from '@electric-sql/pglite';
import { heldCopiesSchemaSql } from '~/server/services/__tests__/held-copies.fixture';
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

const OWNERSHIP_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
);

// One owner per way of being held, and one who is not.
const MARKED_OWNER = 1; // a hold marker
const REPORTED_OWNER = 3; // named on a report not yet sent: no marker row exists for them
const REVIEW_OWNER = 4; // an image awaiting CSAM review: the account hold's image leg
const FREE_OWNER = 2;
const GIVEN_BY_MARKED_OWNER = 5; // unheld; owns a model MARKED_OWNER had before
const GIVEN_BY_FREE_OWNER = 6; // unheld; owns a model FREE_OWNER had before
const MODELS = [
  { id: 10, userId: MARKED_OWNER, versionId: 100 },
  { id: 30, userId: REPORTED_OWNER, versionId: 300 },
  { id: 40, userId: PLACEHOLDER_OWNER_ID, versionId: 400 },
  { id: 50, userId: REVIEW_OWNER, versionId: 500 },
  { id: 20, userId: FREE_OWNER, versionId: 200 },
  { id: 60, userId: GIVEN_BY_MARKED_OWNER, versionId: 600 },
  { id: 70, userId: GIVEN_BY_FREE_OWNER, versionId: 700 },
];
const FREE_MODELS = [20, 70];
const FREE_VERSIONS = [200, 700];
const KEPT_MODELS = [10, 30, 40, 50, 60];

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
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL DEFAULT 'Draft', mode text,
      "deletedBy" int, meta jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "Thread" (
      id serial PRIMARY KEY, "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE, "reviewId" int,
      "postId" int, "imageId" int, "parentThreadId" int, "rootThreadId" int, "commentId" int,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id serial PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
    );
    CREATE TABLE "Comment" (
      id serial PRIMARY KEY, "userId" int NOT NULL,
      "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE, "parentId" int
    );
    CREATE TABLE "ResourceReview" (
      id serial PRIMARY KEY, "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL REFERENCES "Model"(id) ON DELETE CASCADE,
      "createdAt" timestamp(3) NOT NULL, "updatedAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "ModelFile" (
      id serial PRIMARY KEY,
      "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE,
      "createdAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "ImageResourceNew" ("imageId" int NOT NULL, "modelVersionId" int NOT NULL);
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
    );
  `);
  await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  await db.exec(readFileSync(OWNERSHIP_MIGRATION, 'utf8'));
  await db.exec(heldCopiesSchemaSql());
  await db.exec(`
    INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
      (60, ${MARKED_OWNER}, 'create'), (60, ${GIVEN_BY_MARKED_OWNER}, 'transfer'),
      (70, ${FREE_OWNER}, 'create'), (70, ${GIVEN_BY_FREE_OWNER}, 'transfer');
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
  it("keeps every held owner's model, and every model a held owner once had, with its file registrations, and deletes the rest", async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(await remainingModels()).toEqual(KEPT_MODELS);
    // Deregistering a kept model's versions would drop its files out of the quarantine allowlist.
    expect(mockDeregisterBatch.mock.calls.map(([ids]) => [...ids].sort())).toEqual([FREE_VERSIONS]);
    expect(axiomEvents('Removed old draft models')).toEqual([
      expect.objectContaining({ modelIds: FREE_MODELS }),
    ]);
    expect(axiomEvents('Kept old draft models of owners under a legal hold')).toEqual([
      expect.objectContaining({ modelIds: KEPT_MODELS }),
    ]);
  });
});

// Comments are not kept for a held author: they go with the model.
describe("remove-old-drafts and a held author's comments on a free owner's model", () => {
  const LEGACY_MODEL = 160; // a held author left a legacy comment: it cascades and has no thread
  const THREAD_MODEL = 170; // a held author commented in its thread

  beforeEach(async () => {
    const extra = [LEGACY_MODEL, THREAD_MODEL];
    await db.exec(`
      DELETE FROM "Thread"; DELETE FROM "Comment";
      INSERT INTO "Model" (id, "userId") VALUES ${extra
        .map((id) => `(${id}, ${FREE_OWNER})`)
        .join(', ')};
      INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES ${extra
        .map((id) => `(${id}0, ${id}, now() - interval '200 days', now() - interval '200 days')`)
        .join(', ')};
      INSERT INTO "Comment" ("userId", "modelId") VALUES (${MARKED_OWNER}, ${LEGACY_MODEL});
      INSERT INTO "Thread" (id, "modelId") VALUES (700, ${THREAD_MODEL});
      INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES
        (7001, ${MARKED_OWNER}, 700), (7002, ${FREE_OWNER}, 700);
    `);
    dbMock.dbRead.$queryRaw.mockResolvedValue(extra.map((id) => ({ id, userId: FREE_OWNER })));
  });

  it('deletes the models and the comments with them', async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();

    const remaining = await remainingModels();
    expect(remaining).not.toContain(LEGACY_MODEL);
    expect(remaining).not.toContain(THREAD_MODEL);
    expect((await db.query(`SELECT 1 FROM "Comment"`)).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM "CommentV2"`)).rows).toEqual([]);
  });
});

describe("remove-old-drafts and a held author's review of a free owner's model", () => {
  const REVIEWED_MODEL = 190;

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE "HeldResourceReview";
      INSERT INTO "Model" (id, "userId") VALUES (${REVIEWED_MODEL}, ${FREE_OWNER});
      INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES
        (${REVIEWED_MODEL}0, ${REVIEWED_MODEL}, now() - interval '200 days', now() - interval '200 days');
      INSERT INTO "ResourceReview" ("userId", "modelId", "modelVersionId", details) VALUES
        (${MARKED_OWNER}, ${REVIEWED_MODEL}, ${REVIEWED_MODEL}0, 'held'),
        (${FREE_OWNER}, ${REVIEWED_MODEL}, ${REVIEWED_MODEL}0, 'free');
    `);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: REVIEWED_MODEL, userId: FREE_OWNER }]);
  });

  it('deletes the model and its reviews, keeping a copy of the held author’s only', async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(await remainingModels()).not.toContain(REVIEWED_MODEL);
    const reviews = await db.query(
      `SELECT id FROM "ResourceReview" WHERE "modelId" = ${REVIEWED_MODEL}`
    );
    expect(reviews.rows).toEqual([]);
    const copies = await db.query(
      `SELECT "userId", "modelId", details, "holdReasons" FROM "HeldResourceReview"`
    );
    expect(copies.rows).toEqual([
      {
        userId: MARKED_OWNER,
        modelId: REVIEWED_MODEL,
        details: 'held',
        holdReasons: ['hold-marker'],
      },
    ]);
  });
});

// The DELETE re-checks what a moderator did, as it re-checks holds: the replica read can be stale.
describe('remove-old-drafts and models a moderator acted on', () => {
  const MOD = 99;
  const CASES = [
    { id: 210, status: 'Draft', mode: 'TakenDown', deletedBy: null, kept: true },
    { id: 220, status: 'Deleted', mode: null, deletedBy: MOD, kept: true },
    { id: 230, status: 'Deleted', mode: 'TakenDown', deletedBy: null, kept: true },
    { id: 240, status: 'Deleted', mode: null, deletedBy: FREE_OWNER, kept: false },
    { id: 250, status: 'Deleted', mode: null, deletedBy: null, kept: false },
    { id: 260, status: 'Draft', mode: null, deletedBy: null, kept: false },
    // Unpublished by a moderator for a violation, then deleted by its owner.
    {
      id: 270,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: true,
      meta: {
        statusAtDelete: 'UnpublishedViolation',
        unpublishedReason: 'other',
        unpublishedBy: MOD,
      },
    },
    // Unpublished by a moderator, then deleted by its owner.
    {
      id: 271,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: true,
      meta: { statusAtDelete: 'Unpublished', unpublishedBy: MOD },
    },
    // The same, deleted before deletes recorded statusAtDelete: the takedown marks decide.
    {
      id: 272,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: true,
      meta: { unpublishedReason: 'other', unpublishedBy: MOD },
    },
    // A takedown reason alone, with no actor recorded, counts as a moderator's.
    {
      id: 275,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: true,
      meta: { unpublishedReason: 'other' },
    },
    // Controls: the owner unpublished it, or deleted it live.
    {
      id: 273,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: false,
      meta: { statusAtDelete: 'Unpublished', unpublishedBy: FREE_OWNER },
    },
    {
      id: 274,
      status: 'Deleted',
      mode: null,
      deletedBy: FREE_OWNER,
      kept: false,
      meta: { statusAtDelete: 'Published' },
    },
  ] as {
    id: number;
    status: string;
    mode: string | null;
    deletedBy: number | null;
    kept: boolean;
    meta?: Record<string, unknown>;
  }[];
  const sql = (v: string | number | null) =>
    v === null ? 'NULL' : typeof v === 'number' ? v : `'${v}'`;

  beforeEach(async () => {
    await db.exec(`
      DELETE FROM "Model";
      INSERT INTO "Model" (id, "userId", status, mode, "deletedBy", meta) VALUES ${CASES.map(
        (c) =>
          `(${c.id}, ${FREE_OWNER}, ${sql(c.status)}, ${sql(c.mode)}, ${sql(
            c.deletedBy
          )}, ${`'${JSON.stringify(c.meta ?? {})}'`})`
      ).join(', ')};
      INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES ${CASES.map(
        (c) => `(${c.id * 10}, ${c.id}, now() - interval '200 days', now() - interval '200 days')`
      ).join(', ')};
    `);
    dbMock.dbRead.$queryRaw.mockResolvedValue(CASES.map(({ id }) => ({ id, userId: FREE_OWNER })));
  });

  it('keeps a taken-down model and one deleted by a moderator, and reaps owner and account deletes', async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();
    const kept = CASES.filter((c) => c.kept).map((c) => c.id);
    expect(await remainingModels()).toEqual(kept);
    expect(axiomEvents('Kept old draft models a moderator acted on')).toEqual([
      expect.objectContaining({ modelIds: kept }),
    ]);
    expect(axiomEvents('Kept old draft models of owners under a legal hold')).toEqual([]);
  });
});

// Any CsamReport tied to a model keeps it, whatever the report's status and whoever it names.
describe('remove-old-drafts and models tied to a CsamReport', () => {
  const OLD = `now() - interval '2 years'`; // sent and archived this long ago: no longer a legal hold
  const OLD_REPORT_OWNER = 80; // the subject of an old report
  const SECONDARY_OWNER = 84; // the secondary user of an old report
  const PAST_OWNER = 85; // the subject of an old report; gave model 186 away
  const OTHER_SUBJECT = 81; // whom the version and image reports name; owns no model
  const POSTER = 82; // posted or made the listed images
  const cases = {
    oldReportOwner: { id: 180, userId: OLD_REPORT_OWNER },
    listedVersion: { id: 181, userId: FREE_OWNER },
    postedImage: { id: 182, userId: FREE_OWNER },
    secondaryOwner: { id: 184, userId: SECONDARY_OWNER },
    resourceVersion: { id: 185, userId: FREE_OWNER }, // a generated image report names it as a resource
    pastOwner: { id: 186, userId: GIVEN_BY_FREE_OWNER },
    madeWith: { id: 187, userId: FREE_OWNER }, // a listed image was made with it
  };
  const UNLISTED_MODEL = 183; // control: reports list other images, versions and resources
  const tied = [...Object.values(cases), { id: UNLISTED_MODEL, userId: FREE_OWNER }];
  const keptIds = Object.values(cases).map((c) => c.id);

  beforeAll(async () => {
    const { listedVersion, postedImage, resourceVersion, pastOwner, madeWith } = cases;
    await db.exec(`
      INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
        (${pastOwner.id}, ${PAST_OWNER}, 'create'), (${pastOwner.id}, ${GIVEN_BY_FREE_OWNER}, 'transfer');
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES
        (8201, ${POSTER}, ${postedImage.id}0), (8301, ${POSTER}, ${UNLISTED_MODEL}0);
      INSERT INTO "Image" (id, "userId", "postId") VALUES
        (8202, ${POSTER}, 8201), (8302, ${POSTER}, 8301), (8999, ${POSTER}, NULL),
        (8702, ${POSTER}, NULL), (8303, ${POSTER}, NULL);
      INSERT INTO "ImageResourceNew" ("imageId", "modelVersionId") VALUES
        (8702, ${madeWith.id}0), (8303, ${UNLISTED_MODEL}0);
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images, details) VALUES
        (${OLD_REPORT_OWNER}, ${OLD}, ${OLD}, '[]', '{}'),
        (${OTHER_SUBJECT}, ${OLD}, ${OLD}, '[]', '{"secondaryUserId": ${SECONDARY_OWNER}}'),
        (${PAST_OWNER}, ${OLD}, ${OLD}, '[]', '{}'),
        (${OTHER_SUBJECT}, NULL, NULL, '[]', '{"modelVersionIds": [${listedVersion.id}0]}'),
        (${OTHER_SUBJECT}, NULL, NULL, '[]', '{"modelVersionIds": [990100026]}'),
        (${OTHER_SUBJECT}, ${OLD}, ${OLD}, '[{"id": 8202}]', '{}'),
        (${OTHER_SUBJECT}, ${OLD}, ${OLD}, '[{"id": 8999}]', '{}'),
        (${OTHER_SUBJECT}, ${OLD}, ${OLD}, '[{"id": 8702}]', '{}'),
        (${OTHER_SUBJECT}, ${OLD}, ${OLD}, '[]', '{"generatedImages": [{"resources": [
          "urn:air:sdxl:lora:civitai:1@${resourceVersion.id}0", "urn:air:sdxl:lora:civitai:1@${UNLISTED_MODEL}00"
        ]}]}');
    `);
  });

  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Model" (id, "userId") VALUES ${tied
        .map((m) => `(${m.id}, ${m.userId})`)
        .join(', ')};
      INSERT INTO "ModelVersion" (id, "modelId", "createdAt", "updatedAt") VALUES ${tied
        .map((m) => `(${m.id}0, ${m.id}, now() - interval '200 days', now() - interval '200 days')`)
        .join(', ')};
    `);
    dbMock.dbRead.$queryRaw.mockResolvedValue(tied);
  });

  it.each(Object.entries(cases))('keeps the model: %s', async (_name, { id }) => {
    await (removeOldDrafts as unknown as () => Promise<void>)();
    expect(await remainingModels()).toContain(id);
  });

  it('deletes the control, and reports the kept ones apart from legal holds', async () => {
    await (removeOldDrafts as unknown as () => Promise<void>)();
    expect(await remainingModels()).not.toContain(UNLISTED_MODEL);
    expect(axiomEvents('Kept old draft models tied to a CsamReport')).toEqual([
      expect.objectContaining({ modelIds: [...keptIds].sort((a, b) => a - b) }),
    ]);
    expect(axiomEvents('Kept old draft models of owners under a legal hold')).toEqual([]);
  });
});
