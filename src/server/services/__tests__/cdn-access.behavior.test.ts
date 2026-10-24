import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as ConcurrencyHelpers from '~/server/utils/concurrency-helpers';
import type * as FliptClient from '~/server/flipt/client';
import type * as CloudflareClient from '~/server/cloudflare/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The takedown CDN sync end to end on an in-process Postgres: the committed triggers queue the
 * writes the real takedown and restore paths make, and the real drain and reconciler turn the queue
 * into image-server calls. Only the network (`fetch`) is faked, so the assertions are on what the
 * image server is asked to do.
 */

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const BLOCKED_QUEUE_MIGRATION = path.join(
  MIGRATIONS,
  '20260806130000_blocked_image_delete_queue_completeness/migration.sql'
);
const CDN_ACCESS_MIGRATION = path.join(MIGRATIONS, '20261111120000_cdn_access_sync/migration.sql');
const CDN_ACCESS_FIXES_MIGRATION = path.join(
  MIGRATIONS,
  '20261121120000_cdn_access_sync_fixes/migration.sql'
);
const PERSIST_RETRY_MIGRATION = path.join(
  MIGRATIONS,
  '20261129120000_job_queue_image_cdn_persist_retry_type/migration.sql'
);

const EVIDENCE_HOLD_MIGRATION = path.join(MIGRATIONS, '20261019220000_evidence_hold/migration.sql');

/**
 * The hold marker table, its view and the trigger that marks a sent report's users, taken from the
 * migration: the trigger is what holds a reported owner once a report is sent.
 */
const evidenceHoldSql = () => {
  const migration = readFileSync(EVIDENCE_HOLD_MIGRATION, 'utf8');
  const slice = (from: string, to: string) => {
    const start = migration.indexOf(from);
    const end = migration.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`evidence_hold migration has no ${from}`);
    return migration.slice(start, end + to.length);
  };
  return [
    slice('CREATE TABLE "EvidenceHold" (', 'ON "EvidenceHold" ("userId");'),
    slice('CREATE VIEW "EvidenceHeldUser"', 'GROUP BY "userId";'),
    slice(
      'CREATE OR REPLACE FUNCTION evidence_hold_from_csam_report()',
      'EXECUTE FUNCTION evidence_hold_from_csam_report();'
    ),
  ].join('\n');
};

const CACHER = 'http://image-cacher.test';
const OWNER = 10;
const OTHER_OWNER = 11;
const MOD = 900;

/** Image keys as stored: the image server only knows uuid keys. */
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHARED = u(100);
const GONE = u(101);
const DELETED = u(102);

const pg = { db: null as unknown as PGlite };

vi.mock('~/server/utils/concurrency-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ConcurrencyHelpers>()),
  // The retry backoff; the attempts are what is under test, not the wait between them.
  sleep: async () => undefined,
}));
const isFlipt = vi.hoisted(() => vi.fn(async () => true));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
/** The CDN purge: every url it was handed, in order, or a scripted rejection. */
const purged: string[][] = [];
let purgeFails = 0;
const purgeUrlsOrThrow = vi.hoisted(() => vi.fn());
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CloudflareClient>()),
  purgeUrlsOrThrow,
}));

type Call = { method: string; path: string };
const calls: Call[] = [];
/** Statuses to answer, in order, before falling back to 202. */
let scripted: number[] = [];
const fetchFake = vi.fn(async (input: string, init?: { method?: string }) => {
  calls.push({ method: init?.method ?? 'GET', path: input.replace(CACHER, '') });
  const status = scripted.length ? (scripted.shift() as number) : 202;
  return { ok: status >= 200 && status < 300, status } as Response;
});

const realFetch = globalThis.fetch;
const s3Send = vi.spyOn(S3Client.prototype, 'send');

const { syncCdnAccess, reconcileCdnAccess, retryTakedownPersists, sendTakedownPersistOrRetry } =
  await import('~/server/services/cdn-access.service');
const { persistDeletedTakedowns } = await import('~/server/services/cdn-access.service');
const { cdnAccessSync } = await import('~/server/jobs/cdn-access-sync');
const { EVIDENCE_VERIFIED_KEY, CSAM_HOLD_POST_UNPUBLISH_REASON } = await import(
  '~/server/services/cdn-access.service'
);
const { MODERATOR_TAKEDOWN_ACTIVITIES } = await import(
  '~/server/common/moderator-takedown-activities'
);

const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const q = Prisma.sql(strings, ...(values as never[]));
  return pg.db.query(q.text, q.values as unknown[]);
};

beforeAll(async () => {
  pg.db = await PGlite.create();
  await pg.db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete');
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      data jsonb,
      PRIMARY KEY ("entityType", "entityId", type)
    );
    -- As defined in production.
    CREATE FUNCTION create_job_queue_record(entityid integer, entitytype text, type text)
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      VALUES (entityId, entityType::"EntityType", type::"JobQueueType")
      ON CONFLICT DO NOTHING;
    END;
    $$;
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL, meta jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY,
      "modelId" int NOT NULL,
      status text NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "modelVersionId" int,
      "publishedAt" timestamp(3),
      metadata jsonb
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL,
      "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "needsReview" text,
      name text,
      type text NOT NULL DEFAULT 'image'
    );
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY,
      "userId" int,
      activity text NOT NULL,
      "entityType" text,
      "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
  `);
  await pg.db.exec(evidenceHoldSql());
  await pg.db.exec(readFileSync(BLOCKED_QUEUE_MIGRATION, 'utf8'));
  await pg.db.exec(readFileSync(CDN_ACCESS_MIGRATION, 'utf8'));
  await pg.db.exec(readFileSync(CDN_ACCESS_FIXES_MIGRATION, 'utf8'));
  await pg.db.exec(readFileSync(PERSIST_RETRY_MIGRATION, 'utf8'));
});

afterAll(async () => {
  await pg.db.close();
});

beforeEach(async () => {
  await pg.db.exec(`
    TRUNCATE "JobQueue", "Image", "Post", "ModelVersion", "Model", "ModActivity", "CsamReport",
      "EvidenceHold", "ImageCdnAccess", "ImageCdnModeratorDelete", "ImageCdnAccessClaim";
    INSERT INTO "Model" (id, status) VALUES (1, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (1, 1, 'Published');
  `);
  calls.length = 0;
  scripted = [];
  purged.length = 0;
  purgeFails = 0;
  combinedOk.clear();
  purgeUrlsOrThrow.mockReset().mockImplementation(async (urls: string[]) => {
    if (purgeFails > 0) {
      purgeFails--;
      throw new Error('purge failed');
    }
    purged.push(urls);
  });
  loggingMock.logToAxiom.mockClear();
  fetchFake.mockClear();
  s3Send.mockClear();
  isFlipt.mockClear();
  vi.stubGlobal('fetch', fetchFake);
  setEnv({ IMAGE_CACHER_URL: CACHER, IMAGE_CACHER_ADMIN_SECRET: 'secret' });
  const run = async (strings: TemplateStringsArray, ...values: unknown[]) =>
    sql(strings, ...values);
  dbMock.dbWrite.$queryRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    (async (...a: Parameters<typeof run>) => (await run(...a)).affectedRows ?? 0) as never
  );
});

// ── the writes the real paths make ──────────────────────────────────────────────────────────────

const image = (id: number, over: { userId?: number; url?: string; postId?: number } = {}) =>
  sql`INSERT INTO "Image" (id, "userId", url, "postId")
      VALUES (${id}, ${over.userId ?? OWNER}, ${over.url ?? u(id)}, ${over.postId ?? null})`;

const publishedPost = (id: number, userId = OWNER) =>
  sql`INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt")
      VALUES (${id}, ${userId}, 1, now() - interval '1 day')`;

/** `handleBlockImages` / the moderator app's `blockImage`: the block, then the activity row. */
const moderatorBlock = async (id: number) => {
  await sql`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${id}`;
  await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
            VALUES (${MOD}, 'review', 'image', ${id})`;
};
/** The scan pipeline: same `blockedFor`, no activity. */
const scannerBlock = (id: number) =>
  sql`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = ${id}`;
/** `report.service` on a user's CSAM report. */
const reportCsamBlock = (id: number) =>
  sql`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE id = ${id}`;
/** The moderator app's `acceptImage`: un-blocks, drops the delete queue row, writes a `review` row. */
const acceptImage = async (id: number) => {
  await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = ${id}`;
  await sql`DELETE FROM "JobQueue" WHERE type = 'BlockedImageDelete' AND "entityId" = ${id}`;
  await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
            VALUES (${MOD}, 'review', 'image', ${id})`;
};

/** The post UPDATE in `unpublishModelById` / `unpublishModelVersionById`, as `actorId`. */
const modelCascade = async (
  postId: number,
  actorId: number,
  status: string,
  reason: string | null = null
) => {
  await sql`UPDATE "ModelVersion"
    SET status = ${status},
        meta = CASE WHEN ${reason}::text IS NULL THEN meta
                    ELSE meta || jsonb_build_object('unpublishedReason', ${reason}::text) END
    WHERE id = 1`;
  await sql`UPDATE "Post"
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'unpublishedAt', now()::text, 'unpublishedBy', ${actorId}::int, 'prevPublishedAt', "publishedAt"),
        "publishedAt" = NULL
    WHERE id = ${postId} AND "publishedAt" IS NOT NULL`;
};
/** `unpublishPostAsModerator`. */
const moderatorPostUnpublish = (postId: number, reason = 'other') =>
  sql`UPDATE "Post"
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'unpublishedAt', now()::text, 'unpublishedBy', ${MOD}::int,
          'unpublishedReason', ${reason}::text, 'prevPublishedAt', "publishedAt"),
        "publishedAt" = NULL
    WHERE id = ${postId} AND "publishedAt" IS NOT NULL`;
/** The republish in `process-scheduled-publishing` / `publishModelById`. */
const republish = async (postId: number) => {
  await sql`UPDATE "ModelVersion" SET status = 'Published' WHERE id = 1`;
  await sql`UPDATE "Post"
    SET "publishedAt" = ("metadata"->>'prevPublishedAt')::timestamp,
        "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
          - 'unpublishedReason'
    WHERE id = ${postId}`;
};

/** A sent CSAM report with a verified evidence copy, naming `userId` and listing `imageIds`. */
const verifiedReport = (imageIds: number[], userId = OWNER) =>
  sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", details, images)
      VALUES (${userId}, now(), jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'),
              ${JSON.stringify(imageIds.map((id) => ({ id })))}::jsonb)`;
const coverImages = (imageIds: number[]) =>
  sql`UPDATE "CsamReport" SET "reportSentAt" = now(), details = jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'),
      images = ${JSON.stringify(imageIds.map((id) => ({ id })))}::jsonb`;

/** A moderator's manual hold marker on `userId`. */
const holdMarker = (userId: number) =>
  sql`INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${userId}, 'manual', 'test')`;
/**
 * A moderator releasing every hold marker on `userId`. A sent report marks its users held for a year,
 * so a coverage release only shows once the marker is released.
 */
const releaseMarkers = (userId = OWNER) =>
  sql`UPDATE "EvidenceHold"
      SET "releasedAt" = now(), "releasedById" = ${MOD}, "releaseReason" = 'released'
      WHERE "userId" = ${userId} AND "releasedAt" IS NULL`;

// ── observations ────────────────────────────────────────────────────────────────────────────────

const isPersist = (c: Call) => c.path.includes('persist=');
const kind = (c: Call) =>
  c.method === 'DELETE' ? 'allow' : c.path.includes('retractPublicBlobs=true') ? 'retract' : 'deny';
const onUrl = (url: string) => (c: Call) => c.path.includes(`imageKey=${encodeURIComponent(url)}`);
/** The calls that move a url's state. A persist follows a retraction and is read separately. */
const callsFor = (url: string) =>
  calls
    .filter(onUrl(url))
    .filter((c) => !isPersist(c))
    .map(kind);
const persistsFor = (url: string) => calls.filter(onUrl(url)).filter(isPersist);
/** Urls a test sends a retraction-carrying persist for on purpose: a hard-deleted takedown's retry. */
const combinedOk = new Set<string>();
const retryRows = async () =>
  (
    await sql`SELECT "entityId", data FROM "JobQueue" WHERE type = 'ImageCdnPersistRetry'
              ORDER BY "entityId"`
  ).rows as { entityId: number; data: Record<string, unknown> }[];
const logsOf = (type: string, name: string) =>
  loggingMock.logToAxiom.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((x) => x.type === type && x.name === name);
const errorLogs = (name: string) => logsOf('error', name);

/**
 * 🔴 Every scenario in this file doubles as a negative: a persist goes out only for a url this run
 * has retracted and not lifted since, and as exactly `&persist=true`. A persist leaking onto a deny,
 * a lift or a re-assert fails whichever test drove it there.
 */
afterEach(() => {
  const retracted = new Set<string>();
  for (const c of calls) {
    const key = /imageKey=([^&]+)/.exec(c.path)?.[1] ?? '';
    if (!isPersist(c)) {
      if (kind(c) === 'retract') retracted.add(key);
      if (kind(c) === 'allow') retracted.delete(key);
      continue;
    }
    expect(c.path, 'persist sent with a value other than true').toMatch(/&persist=true(&|$)/);
    expect(c.method).toBe('POST');
    // Only a retry for a hard-deleted takedown carries its own retraction.
    if (kind(c) === 'retract') {
      expect(
        combinedOk.has(decodeURIComponent(key)),
        `persist rode on a retraction: ${c.path}`
      ).toBe(true);
      continue;
    }
    expect(retracted.has(key), `persist sent for ${c.path} without a standing retraction`).toBe(
      true
    );
  }
});
const queued = async () =>
  (await sql`SELECT count(*)::int AS n FROM "JobQueue" WHERE type = 'CdnAccessSync'`).rows[0] as {
    n: number;
  };
const stateOf = async (url: string) =>
  (
    (await sql`SELECT state FROM "ImageCdnAccess" WHERE url = ${url}`).rows[0] as
      | { state: string }
      | undefined
  )?.state;

describe('image takedowns', () => {
  it('a moderator block denies and retracts', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
    expect(await stateOf(u(1))).toBe('Retracted');
    expect((await queued()).n).toBe(0);
  });

  it('an automated block denies without retracting', async () => {
    await image(1);
    await scannerBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(await stateOf(u(1))).toBe('Denied');
  });

  it('a report-driven CSAM block is deny only until a moderator acts, then retracts', async () => {
    await image(1);
    await reportCsamBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
              VALUES (${MOD}, 'review', 'image', 1)`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('an activity older than the block does not make it a takedown', async () => {
    await image(1);
    await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId", "createdAt")
              VALUES (${MOD}, 'review', 'image', 1, now() - interval '1 hour')`;
    await scannerBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a moderator un-block lifts the deny and is never read as a takedown', async () => {
    await image(1);
    await scannerBlock(1);
    await syncCdnAccess();
    // The delete-queue row survives this un-block, and the review row post-dates it.
    await acceptImage(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'allow']);
    expect(await stateOf(u(1))).toBeUndefined();
  });

  it('a report-driven block after a moderator accept is deny only', async () => {
    await image(1);
    await scannerBlock(1);
    await syncCdnAccess();
    await acceptImage(1);
    await syncCdnAccess();
    calls.length = 0;
    await reportCsamBlock(1);
    await syncCdnAccess();
    expect(calls.map(kind)).toEqual(['deny']);
  });

  it('an AiNotVerified block makes no call', async () => {
    await image(1);
    await sql`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'AiNotVerified' WHERE id = 1`;
    expect((await queued()).n).toBe(1);
    await syncCdnAccess();
    expect(calls).toEqual([]);
  });

  it('an image inserted already Blocked is denied', async () => {
    await sql`INSERT INTO "Image" (id, "userId", url, ingestion, "blockedFor")
              VALUES (1, ${OWNER}, ${u(1)}, 'Blocked', 'moderated')`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('restoring a retracted image lifts the deny', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = 1`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'allow']);
    expect(await stateOf(u(1))).toBeUndefined();
  });

  it('only the takedown activity kinds queue a re-check', async () => {
    await image(1);
    for (const activity of MODERATOR_TAKEDOWN_ACTIVITIES) {
      await sql`DELETE FROM "JobQueue"`;
      await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
                VALUES (${MOD}, ${activity}, 'image', 1)`;
      expect((await queued()).n, activity).toBe(1);
    }
    await sql`DELETE FROM "JobQueue"`;
    await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
              VALUES (${MOD}, 'bulkRestore', 'image', 1)`;
    expect((await queued()).n).toBe(0);
  });
});

describe('post takedowns', () => {
  beforeEach(async () => {
    await publishedPost(5);
    await image(1, { postId: 5 });
    await image(2, { postId: 5 });
  });

  it('a violation unpublish by a moderator retracts every image, and a republish lifts them', async () => {
    await modelCascade(5, MOD, 'UnpublishedViolation');
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
    expect(callsFor(u(2))).toEqual(['retract']);

    await republish(5);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'allow']);
    expect(callsFor(u(2))).toEqual(['retract', 'allow']);
  });

  it('a moderator post unpublish retracts', async () => {
    await moderatorPostUnpublish(5);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
  });

  it('a reason left by an earlier moderator unpublish does not make an owner unpublish a takedown', async () => {
    await moderatorPostUnpublish(5);
    await syncCdnAccess();
    // A republish that kept the reason, as one could before republishing cleared it.
    await sql`UPDATE "Post"
      SET "publishedAt" = ("metadata"->>'prevPublishedAt')::timestamp,
          "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy' - 'prevPublishedAt'
      WHERE id = 5`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'allow']);
    calls.length = 0;
    await modelCascade(5, OWNER, 'Unpublished');
    await syncCdnAccess();
    expect(calls).toEqual([]);
  });

  it('a csam-hold removal is deny only until a report exists, then follows the evidence rule', async () => {
    await moderatorPostUnpublish(5, CSAM_HOLD_POST_UNPUBLISH_REASON);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await sql`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`;
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await coverImages([1, 2]);
    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('a csam-hold removal is not released by an earlier report about other images', async () => {
    await verifiedReport([900]);
    await moderatorPostUnpublish(5, CSAM_HOLD_POST_UNPUBLISH_REASON);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a mature-underage violation unpublish is deny only until a verified report releases it', async () => {
    await modelCascade(5, MOD, 'UnpublishedViolation', 'mature-underage');
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    // A report alone does not release it, sent or not, until its evidence is verified.
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt") VALUES (${OWNER}, now())`;
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await coverImages([1, 2]);
    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('a mature-underage violation unpublish is not released by an earlier report about other images', async () => {
    await verifiedReport([900]);
    await modelCascade(5, MOD, 'UnpublishedViolation', 'mature-underage');
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('an owner unpublishing their own model makes no call', async () => {
    await modelCascade(5, OWNER, 'Unpublished');
    expect((await queued()).n).toBe(1);
    await syncCdnAccess();
    expect(calls).toEqual([]);
    expect((await queued()).n).toBe(0);
  });

  it('an owner-unpublished post stays allowed when its model later becomes a violation', async () => {
    await modelCascade(5, OWNER, 'Unpublished');
    await sql`UPDATE "ModelVersion" SET status = 'UnpublishedViolation' WHERE id = 1`;
    await sql`SELECT queue_cdn_access_sync(5, 'Post', NULL)`;
    await syncCdnAccess();
    expect(calls).toEqual([]);
  });

  it('the ban cascade denies without retracting', async () => {
    await modelCascade(5, MOD, 'Unpublished');
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['deny']);
  });

  it('a draft that was never published makes no call', async () => {
    await sql`INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (6, ${OWNER}, 1)`;
    await image(3, { postId: 6 });
    await sql`UPDATE "ModelVersion" SET status = 'UnpublishedViolation' WHERE id = 1`;
    await sql`SELECT queue_cdn_access_sync(3, 'Image', NULL)`;
    await syncCdnAccess();
    expect(calls).toEqual([]);
  });

  it('a first publish queues nothing', async () => {
    await sql`INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (7, ${OWNER}, 1)`;
    await sql`UPDATE "Post" SET "publishedAt" = now() WHERE id = 7`;
    expect((await queued()).n).toBe(0);
  });
});

describe('shared url', () => {
  it('a takedown wins over a live image of the same owner, and retracts', async () => {
    await image(1, { url: SHARED });
    await image(2, { url: SHARED });
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(SHARED)).toEqual(['retract']);
  });

  it('a takedown on a url another owner also uses stops it serving but does not retract', async () => {
    await image(1, { url: SHARED });
    await image(2, { url: SHARED, userId: OTHER_OWNER });
    await moderatorBlock(2);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(SHARED)).toEqual(['deny']);
  });

  it('the live copy does not lift a deny the takedown holds', async () => {
    await image(1, { url: SHARED });
    await image(2, { url: SHARED, userId: OTHER_OWNER });
    await moderatorBlock(2);
    await syncCdnAccess();
    // Any later write to the live copy re-checks the url; it must stay taken down.
    await sql`SELECT queue_cdn_access_sync(1, 'Image', NULL)`;
    await syncCdnAccess();
    expect(callsFor(SHARED)).toEqual(['deny']);
  });
});

describe('evidence holds', () => {
  it('a CSAM review flag caps a human takedown at deny, and the release upgrades it', async () => {
    await image(1);
    await sql`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`;
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await sql`UPDATE "Image" SET "needsReview" = NULL WHERE id = 1`;
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('an unsent CSAM report on the owner caps it at deny', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`;
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a sent report still holds while its evidence copy is unverified, archivedAt or not', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
              VALUES (${OWNER}, now(), now())`;
    await moderatorBlock(1);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    // Verification of a report covering the image is what releases it; the next reconcile upgrades.
    await coverImages([1]);
    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('a verification marker that is not a timestamp still holds', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", details)
              VALUES (${OWNER}, now(), jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, 'pending'))`;
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a sent report covering the image holds through its marker until the marker is released', async () => {
    await image(1);
    await verifiedReport([1]);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);

    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
  });

  it('an unsent report naming the owner as its secondary user holds', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId", details)
              VALUES (${OTHER_OWNER}, jsonb_build_object('secondaryUserId', ${OWNER}::int))`;
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('an unsent report on the owner holds an image another verified report covers', async () => {
    await image(1);
    await image(2, { userId: OTHER_OWNER });
    await verifiedReport([1]);
    await verifiedReport([2], OTHER_OWNER);
    await releaseMarkers(OWNER);
    await releaseMarkers(OTHER_OWNER);
    await sql`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`;
    await sql`INSERT INTO "CsamReport" ("userId", details)
              VALUES (${MOD}, jsonb_build_object('secondaryUserId', ${OTHER_OWNER}::int))`;
    await moderatorBlock(1);
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['deny']);
  });

  it('a failed hold lookup holds everyone', async () => {
    await image(1);
    await moderatorBlock(1);
    await pg.db.exec(`ALTER TABLE "CsamReport" RENAME TO "CsamReportAway"`);
    try {
      await syncCdnAccess();
    } finally {
      await pg.db.exec(`ALTER TABLE "CsamReportAway" RENAME TO "CsamReport"`);
    }
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('an active hold marker on the owner caps a takedown at deny', async () => {
    await image(1);
    await image(2, { userId: OTHER_OWNER });
    await holdMarker(OWNER);
    await moderatorBlock(1);
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['retract']);
  });

  it('a hold marker holds an image a verified report covers', async () => {
    await image(1);
    await verifiedReport([1]);
    await releaseMarkers();
    await holdMarker(OWNER);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a released or expired hold marker does not hold', async () => {
    await image(1);
    await image(2, { userId: OTHER_OWNER });
    await holdMarker(OWNER);
    await releaseMarkers(OWNER);
    await sql`INSERT INTO "EvidenceHold" ("userId", role, reason, "releaseAt")
              VALUES (${OTHER_OWNER}, 'manual', 'test', now() - interval '1 day')`;
    await moderatorBlock(1);
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
    expect(callsFor(u(2))).toEqual(['retract']);
  });

  it('a missing hold marker view holds everyone', async () => {
    await image(1);
    await verifiedReport([1]);
    await releaseMarkers();
    await moderatorBlock(1);
    await pg.db.exec(`ALTER VIEW "EvidenceHeldUser" RENAME TO "EvidenceHeldUserAway"`);
    try {
      await syncCdnAccess();
    } finally {
      await pg.db.exec(`ALTER VIEW "EvidenceHeldUserAway" RENAME TO "EvidenceHeldUser"`);
    }
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a held image caps a shared url, even when the other row is a takedown', async () => {
    await image(1, { url: SHARED });
    await image(2, { url: SHARED, userId: OTHER_OWNER });
    await sql`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 1`;
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(SHARED)).toEqual(['deny']);
  });
});

describe('report coverage', () => {
  it('a takedown of a reported owner that no verified report covers is deny only', async () => {
    await image(1);
    await verifiedReport([2]);
    await moderatorBlock(1);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a takedown a verified report covers retracts', async () => {
    await image(1);
    await verifiedReport([1]);
    await releaseMarkers();
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
  });

  it('a takedown of an owner no report names retracts', async () => {
    await image(1);
    await verifiedReport([1], OTHER_OWNER);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
  });

  it('a report that lists the image but names someone else does not release a reported owner', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", details)
              VALUES (${OWNER}, now(), jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'))`;
    await verifiedReport([1], OTHER_OWNER);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a covering report that is not verified, or not sent, does not release', async () => {
    await image(1);
    await image(2);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", images)
              VALUES (${OWNER}, now(), '[{"id": 1}]'::jsonb)`;
    await sql`INSERT INTO "CsamReport" ("userId", details, images)
              VALUES (${OWNER}, jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'), '[{"id": 2}]'::jsonb)`;
    await moderatorBlock(1);
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['deny']);
  });

  it('a covering report that is unsent or unverified covers nothing on its own', async () => {
    await image(1);
    await image(2);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", images)
              VALUES (${OWNER}, now(), '[{"id": 1}]'::jsonb)`;
    await sql`INSERT INTO "CsamReport" ("userId", details, images)
              VALUES (${OWNER}, jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'),
                      '[{"id": 2}]'::jsonb)`;
    await moderatorBlock(1);
    await moderatorBlock(2);
    // The owner's evidence hold is read as lifted, so only coverage decides.
    const queryRaw = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (...a: unknown[]) => {
      const rows = await queryRaw?.(...(a as Parameters<NonNullable<typeof queryRaw>>));
      return (a[0] as readonly string[]).join('').includes('AS reported')
        ? (rows as { held: boolean }[]).map((r) => ({ ...r, held: false }))
        : rows;
    }) as never);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['deny']);
  });

  it('a failed coverage lookup releases nothing', async () => {
    await image(1);
    await verifiedReport([1]);
    await moderatorBlock(1);
    await pg.db.exec(`ALTER TABLE "CsamReport" RENAME COLUMN images TO "imagesAway"`);
    try {
      await syncCdnAccess();
    } finally {
      await pg.db.exec(`ALTER TABLE "CsamReport" RENAME COLUMN "imagesAway" TO images`);
    }
    expect(callsFor(u(1))).toEqual(['deny']);
  });

  it('a verified report with no image list covers nothing', async () => {
    await image(1);
    await sql`INSERT INTO "CsamReport" ("userId", "reportSentAt", details, images)
              VALUES (${OWNER}, now(), jsonb_build_object(${EVIDENCE_VERIFIED_KEY}::text, '2026-10-20T12:00:00Z'), '{"id": 1}'::jsonb)`;
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
  });
});

describe('moderator-app deletes', () => {
  const queueDelete = (id: number, url: string, { userId = OWNER, csamReview = false } = {}) =>
    sql`SELECT queue_cdn_access_sync(${id}::int, 'Image',
          ${JSON.stringify({ url, userId, csamReview, moderatorDelete: true })}::jsonb)`;

  it('retracts a deleted image by the url the queue row carries', async () => {
    await queueDelete(1, GONE);
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['retract']);
  });

  it('denies only when the owner is held', async () => {
    await sql`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`;
    await queueDelete(1, GONE);
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);
  });

  it('denies when the owner has an active hold marker', async () => {
    await holdMarker(OWNER);
    await queueDelete(1, GONE);
    await queueDelete(2, DELETED, { userId: OTHER_OWNER });
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);
    expect(callsFor(DELETED)).toEqual(['retract']);
  });

  it('denies a delete a verified report covers when the owner has a hold marker', async () => {
    await queueDelete(1, GONE);
    await verifiedReport([1]);
    await releaseMarkers();
    await holdMarker(OWNER);
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);
  });

  it('denies only when the deleted image was flagged for CSAM review, or the row does not say', async () => {
    await queueDelete(1, GONE, { csamReview: true });
    await sql`SELECT queue_cdn_access_sync(2, 'Image',
          ${JSON.stringify({ url: u(2), userId: OWNER, moderatorDelete: true })}::jsonb)`;
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual(['deny']);
  });

  it('keeps a delete on a url the same owner still uses retracted through the reconciler', async () => {
    await image(1, { url: SHARED });
    await queueDelete(2, SHARED);
    await syncCdnAccess();
    await reconcileCdnAccess();
    // A later write to the surviving row re-checks the url.
    await sql`SELECT queue_cdn_access_sync(1, 'Image', NULL)`;
    await syncCdnAccess();
    expect(callsFor(SHARED)).toEqual(['retract']);
  });

  it('keeps a delete on a url another owner still uses denied through the reconciler', async () => {
    await image(1, { url: SHARED });
    await queueDelete(2, SHARED, { userId: OTHER_OWNER });
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(SHARED)).toEqual(['deny']);
    expect(await stateOf(SHARED)).toBe('Denied');
  });

  it('keeps a held delete on record and retracts once the hold is released', async () => {
    await sql`INSERT INTO "CsamReport" ("userId") VALUES (${OWNER})`;
    await queueDelete(1, GONE);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(await stateOf(GONE)).toBe('Denied');

    await coverImages([1]);
    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny', 'retract']);
    expect(await stateOf(GONE)).toBe('Retracted');
  });

  it('releases a delete flagged for CSAM review only once a verified report covers it', async () => {
    await queueDelete(1, GONE, { csamReview: true });
    await verifiedReport([900]);
    await syncCdnAccess();
    await reconcileCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);

    await verifiedReport([1]);
    await releaseMarkers();
    await reconcileCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny', 'retract']);
  });

  it('denies only when the queue row does not say whose image it was', async () => {
    await sql`SELECT queue_cdn_access_sync(1, 'Image',
          ${JSON.stringify({ url: GONE, moderatorDelete: true })}::jsonb)`;
    await syncCdnAccess();
    expect(callsFor(GONE)).toEqual(['deny']);
  });
});

describe('image keys', () => {
  it('skips a url the image server does not serve', async () => {
    await image(1, { url: 'https://example.com/legacy.jpeg' });
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(calls).toEqual([]);
    expect((await queued()).n).toBe(0);
  });

  it('sends a mixed-case uuid key in lowercase', async () => {
    const key = 'abcdef12-3456-4789-8abc-def012345678';
    await image(1, { url: key.toUpperCase() });
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(callsFor(key)).toEqual(['retract']);
  });
});

describe('failures', () => {
  it('retries a failed call and drains once it succeeds', async () => {
    await image(1);
    await scannerBlock(1);
    scripted = [503];
    await syncCdnAccess();
    expect(calls.map(kind)).toEqual(['deny', 'deny']);
    expect((await queued()).n).toBe(0);
  });

  it('keeps the queue row and the old state when every attempt fails, and retries next run', async () => {
    await image(1);
    await scannerBlock(1);
    scripted = [503, 503, 503];
    const first = await syncCdnAccess();
    expect(first.failed).toBe(1);
    expect((await queued()).n).toBe(1);
    expect(await stateOf(u(1))).toBeUndefined();

    await syncCdnAccess();
    expect(calls.map(kind)).toEqual(['deny', 'deny', 'deny', 'deny']);
    expect(await stateOf(u(1))).toBe('Denied');
    expect((await queued()).n).toBe(0);
  });

  it('does not call the image server without the admin secret', async () => {
    setEnv({ IMAGE_CACHER_ADMIN_SECRET: '' });
    await image(1);
    await scannerBlock(1);
    const result = await syncCdnAccess();
    expect(calls).toEqual([]);
    expect(result.failed).toBe(1);
    expect((await queued()).n).toBe(1);
  });

  it('a run that overlaps another on the same url leaves the newer takedown in place', async () => {
    await image(1);
    await scannerBlock(1);
    await syncCdnAccess();
    await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = 1`;
    fetchFake.mockImplementationOnce(async (input: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path: input.replace(CACHER, '') });
      // A second run starts while this run's lift is in flight, after a fresh takedown.
      await moderatorBlock(1);
      await syncCdnAccess();
      return { ok: true, status: 200 } as Response;
    });
    await syncCdnAccess();
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'allow', 'retract']);
    expect(await stateOf(u(1))).toBe('Retracted');
  });

  it("a re-takedown during another run's lift of a retracted url is not lost", async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = 1`;
    fetchFake.mockImplementationOnce(async (input: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path: input.replace(CACHER, '') });
      // The lift is in flight: the image is taken down again and a second run reads it as done.
      await moderatorBlock(1);
      await syncCdnAccess();
      return { ok: true, status: 200 } as Response;
    });
    await syncCdnAccess();
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'allow', 'retract']);
    expect(await stateOf(u(1))).toBe('Retracted');
  });

  it('keeps the queue row of a url another run changed after this run read it', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await sql`SELECT queue_cdn_access_sync(1, 'Image', NULL)`;
    const queryRaw = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation((async (...a: unknown[]) => {
      if ((a[0] as readonly string[]).join('').includes('"ImageCdnAccessClaim" k'))
        // Another run finished lifting the url between this run's read and its last look.
        await sql`DELETE FROM "ImageCdnAccess" WHERE url = ${u(1)}`;
      return queryRaw?.(...(a as Parameters<NonNullable<typeof queryRaw>>));
    }) as never);
    await syncCdnAccess();
    expect((await queued()).n).toBe(1);
  });

  it('removes the queue row of a url already in its state', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await sql`SELECT queue_cdn_access_sync(1, 'Image', NULL)`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract']);
    expect((await queued()).n).toBe(0);
  });

  it('keeps a row that was queued again while the run was reading it', async () => {
    await image(1);
    await scannerBlock(1);
    fetchFake.mockImplementationOnce(async (input: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', path: input.replace(CACHER, '') });
      await sql`SELECT queue_cdn_access_sync(1, 'Image', NULL)`;
      return { ok: true, status: 202 } as Response;
    });
    await syncCdnAccess();
    expect((await queued()).n).toBe(1);
  });
});

describe('reconciler', () => {
  it('re-asserts an old deny, leaves a fresh one, and forgets a url with no rows left', async () => {
    await image(1);
    await image(2);
    await scannerBlock(1);
    await scannerBlock(2);
    await syncCdnAccess();
    calls.length = 0;
    await sql`UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() - interval '25 days' WHERE url = ${u(
      1
    )}`;
    await sql`INSERT INTO "ImageCdnAccess" (url, state) VALUES (${DELETED}, 'Retracted')`;

    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(callsFor(u(2))).toEqual([]);
    expect(callsFor(DELETED)).toEqual([]);
    expect(await stateOf(DELETED)).toBeUndefined();
  });

  it('caps re-asserts per run and picks up the rest on the next one', async () => {
    for (const id of [1, 2, 3]) {
      await image(id);
      await scannerBlock(id);
    }
    await syncCdnAccess();
    calls.length = 0;
    await sql`UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() - interval '25 days'`;

    await reconcileCdnAccess({ reassertCap: 2 });
    expect(calls.map(kind)).toEqual(['deny', 'deny']);
    await reconcileCdnAccess({ reassertCap: 2 });
    expect(calls.map(kind)).toEqual(['deny', 'deny', 'deny']);
  });

  it('keeps a url a moderator delete was recorded for while it was deciding to forget it', async () => {
    await sql`INSERT INTO "ImageCdnAccess" (url, state) VALUES (${GONE}, 'Denied')`;
    const executeRaw = dbMock.dbWrite.$executeRaw.getMockImplementation();
    dbMock.dbWrite.$executeRaw.mockImplementation((async (...a: unknown[]) => {
      if ((a[0] as readonly string[]).join('').includes('DELETE FROM "ImageCdnAccess" a'))
        // A drain records the delete after this run read the url as having nothing left.
        await sql`INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview")
                  VALUES (1, ${GONE}, ${OWNER}, false)`;
      return executeRaw?.(...(a as Parameters<NonNullable<typeof executeRaw>>));
    }) as never);
    await reconcileCdnAccess();
    expect(await stateOf(GONE)).toBe('Denied');
  });

  it('re-asserts a retracted url with a deny, not another retraction', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await sql`UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() - interval '25 days'`;
    await reconcileCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'deny']);
    expect(await stateOf(u(1))).toBe('Retracted');
  });
});

describe('scope of what it calls', () => {
  it('calls only the image server deny and invalidate endpoints, and never object storage', async () => {
    await publishedPost(5);
    await image(1);
    await image(2, { postId: 5 });
    await image(3);
    await moderatorBlock(1);
    await modelCascade(5, MOD, 'UnpublishedViolation');
    await scannerBlock(3);
    await sql`SELECT queue_cdn_access_sync(9, 'Image', ${JSON.stringify({
      url: GONE,
      userId: OWNER,
      moderatorDelete: true,
    })}::jsonb)`;
    await syncCdnAccess();
    await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = 3`;
    await syncCdnAccess();
    await sql`UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() - interval '25 days'`;
    await reconcileCdnAccess();

    // Control: the scenario exercised every call kind, so the check below saw real traffic.
    expect(new Set(calls.map(kind))).toEqual(new Set(['retract', 'deny', 'allow']));
    expect(calls.some(isPersist)).toBe(true);
    // A takedown's persist is its own invalidate, after the retraction rather than on it.
    for (const c of calls)
      expect(c.path).toMatch(
        /^\/admin\/(invalidate|deny)\?imageKey=[^&]+(&retractPublicBlobs=true|&persist=true)?$/
      );
    expect(s3Send).not.toHaveBeenCalled();
  });
});

describe('image server requests', () => {
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<Server>((resolve) => {
      const server = createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = (server: Server) => new Promise((resolve) => server.close(resolve));

  it('sends the admin secret and never follows a redirect', async () => {
    const elsewhere: string[] = [];
    const target = await listen((req, res) => {
      elsewhere.push(String(req.headers['x-admin-secret']));
      res.writeHead(200).end();
    });
    const secrets: (string | undefined)[] = [];
    const cacher = await listen((req, res) => {
      secrets.push(req.headers['x-admin-secret'] as string | undefined);
      res.writeHead(307, { Location: `${origin(target)}${req.url}` }).end();
    });
    try {
      vi.stubGlobal('fetch', realFetch);
      setEnv({ IMAGE_CACHER_URL: origin(cacher) });
      await image(1);
      await scannerBlock(1);
      const result = await syncCdnAccess();
      expect(secrets).toEqual(['secret', 'secret', 'secret']);
      expect(elsewhere).toEqual([]);
      expect(result.failed).toBe(1);
      expect((await queued()).n).toBe(1);
    } finally {
      await Promise.all([close(cacher), close(target)]);
    }
  });
});

describe('flag', () => {
  it('does nothing while the flag is off', async () => {
    isFlipt.mockResolvedValueOnce(false);
    await image(1);
    await moderatorBlock(1);
    await cdnAccessSync.run({}).result;
    expect(calls).toEqual([]);
    expect((await queued()).n).toBe(1);
  });
});

describe('takedown persist', () => {
  const persistedBeforePurge = () =>
    Math.max(...fetchFake.mock.invocationCallOrder) <
    Math.min(...purgeUrlsOrThrow.mock.invocationCallOrder);

  it('a moderator block persists after the retraction, then purges the CDN', async () => {
    await image(1);
    await sql`UPDATE "Image" SET name = 'cat.png' WHERE id = 1`;
    await moderatorBlock(1);
    await syncCdnAccess();

    expect(callsFor(u(1))).toEqual(['retract']);
    expect(persistsFor(u(1)).map((c) => c.path)).toEqual([
      `/admin/invalidate?imageKey=${u(1)}&persist=true`,
    ]);
    expect(purged).toHaveLength(1);
    // Every name it is served under: its key first, then its id, then its own name.
    expect(purged[0][0]).toBe(`${u(1)}/original=true/${u(1)}.jpeg`);
    expect(purged[0]).toEqual(
      expect.arrayContaining([
        `${u(1)}/original=true/1.jpeg`,
        `${u(1)}/anim=false,original=true/cat.jpeg`,
        `${u(1)}/width=450,optimized=true/cat.jpeg`,
      ])
    );
    expect(purged[0]).toHaveLength(102);
    expect(persistedBeforePurge()).toBe(true);
    expect(await retryRows()).toEqual([]);
  });

  it('a moderator bulk removal persists', async () => {
    await image(1);
    await sql`UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'moderated' WHERE id = 1`;
    await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
              VALUES (${MOD}, 'bulkRemove', 'image', 1)`;
    await syncCdnAccess();
    expect(persistsFor(u(1))).toHaveLength(1);
  });

  it('a moderator violation unpublish persists every image on the post', async () => {
    await publishedPost(5);
    await image(1, { postId: 5 });
    await image(2, { postId: 5 });
    await modelCascade(5, MOD, 'UnpublishedViolation');
    await syncCdnAccess();
    expect(persistsFor(u(1))).toHaveLength(1);
    expect(persistsFor(u(2))).toHaveLength(1);
  });

  it('a moderator-app delete persists and purges under the key name', async () => {
    await sql`SELECT queue_cdn_access_sync(9, 'Image', ${JSON.stringify({
      url: DELETED,
      userId: OWNER,
      csamReview: false,
      moderatorDelete: true,
    })}::jsonb)`;
    await syncCdnAccess();
    expect(callsFor(DELETED)).toEqual(['retract']);
    expect(persistsFor(DELETED)).toHaveLength(1);
    expect(purged).toHaveLength(1);
    expect(purged[0]).toEqual(
      expect.arrayContaining([
        `${DELETED}/original=true/${DELETED}.jpeg`,
        `${DELETED}/original=true/9.jpeg`,
      ])
    );
    expect(purged[0]).toHaveLength(68);
  });

  it('a released CSAM hold persists once the takedown upgrades to a retraction', async () => {
    await image(1);
    await image(2);
    await sql`UPDATE "Image" SET "needsReview" = 'csam' WHERE id IN (1, 2)`;
    await moderatorBlock(1);
    await moderatorBlock(2);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny']);
    expect(persistsFor(u(1))).toEqual([]);

    // Released on the drain path: the next write queues a re-check.
    await sql`UPDATE "Image" SET "needsReview" = NULL WHERE id = 1`;
    await sql`INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
              VALUES (${MOD}, 'review', 'image', 1)`;
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['deny', 'retract']);
    expect(persistsFor(u(1))).toHaveLength(1);

    // Released with no write: the reconciler upgrades it.
    await sql`UPDATE "Image" SET "needsReview" = NULL WHERE id = 2`;
    await sql`DELETE FROM "JobQueue" WHERE type = 'CdnAccessSync'`;
    await reconcileCdnAccess();
    expect(callsFor(u(2))).toEqual(['deny', 'retract']);
    expect(persistsFor(u(2))).toHaveLength(1);
  });

  it('nothing but a retraction persists', async () => {
    await publishedPost(5);
    await image(1);
    await image(2);
    await image(3);
    await image(4, { postId: 5 });
    await image(6);
    await scannerBlock(1);
    await reportCsamBlock(2);
    await sql`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 3`;
    await moderatorBlock(3);
    await modelCascade(5, OTHER_OWNER, 'Published');
    // Control: a takedown in the same runs does persist, so the empty results below are not
    // a persist that never runs at all.
    await moderatorBlock(6);
    await syncCdnAccess();
    await sql`UPDATE "Image" SET ingestion = 'Scanned', "blockedFor" = NULL WHERE id = 1`;
    await syncCdnAccess();
    await sql`UPDATE "ImageCdnAccess" SET "lastAssertedAt" = now() - interval '25 days'`;
    await reconcileCdnAccess();

    expect(callsFor(u(1))).toEqual(['deny', 'allow']);
    expect(callsFor(u(2))).toEqual(['deny', 'deny']);
    expect(callsFor(u(3))).toEqual(['deny', 'deny']);
    expect(callsFor(u(4))).toEqual(['deny', 'deny']);
    for (const id of [1, 2, 3, 4]) expect(persistsFor(u(id)), `image ${id}`).toEqual([]);
    expect(persistsFor(u(6))).toHaveLength(1);
    expect(purged).toHaveLength(1);
  });

  it('a failed persist leaves the takedown standing and queues one retry', async () => {
    await image(1);
    await moderatorBlock(1);
    scripted = [202, 500, 500, 500];
    await syncCdnAccess();

    expect(callsFor(u(1))).toEqual(['retract']);
    expect(persistsFor(u(1))).toHaveLength(3);
    expect(await stateOf(u(1))).toBe('Retracted');
    expect((await queued()).n).toBe(0);
    expect(purged).toEqual([]);
    expect(logsOf('warning', 'takedown-persist-failed')).toEqual([
      expect.objectContaining({ imageIds: [1], imageKey: u(1) }),
    ]);
    expect(await retryRows()).toEqual([
      { entityId: 1, data: { url: u(1), retract: false, purgeEdge: true } },
    ]);

    expect(await retryTakedownPersists()).toMatchObject({ queued: 1, sent: 1 });
    expect(persistsFor(u(1))).toHaveLength(4);
    expect(callsFor(u(1))).toEqual(['retract']);
    expect(purged).toHaveLength(1);
    expect(await retryRows()).toEqual([]);
  });

  it('retries once only: a second failure is logged and dropped', async () => {
    await image(1);
    await moderatorBlock(1);
    scripted = [202, 500, 500, 500];
    await syncCdnAccess();
    expect(await retryRows()).toHaveLength(1);

    scripted = [500, 500, 500];
    expect(await retryTakedownPersists()).toMatchObject({ queued: 1, failed: 1 });
    expect(await retryRows()).toEqual([]);
    expect(errorLogs('takedown-persist-retry-failed')).toEqual([
      expect.objectContaining({ imageId: 1, imageKey: u(1) }),
    ]);
    expect(await stateOf(u(1))).toBe('Retracted');
  });

  it('a failed CDN purge queues the retry, which purges', async () => {
    await image(1);
    await moderatorBlock(1);
    purgeFails = 1;
    await syncCdnAccess();
    expect(persistsFor(u(1))).toHaveLength(1);
    expect(await stateOf(u(1))).toBe('Retracted');
    expect(await retryRows()).toHaveLength(1);

    await retryTakedownPersists();
    expect(purged).toHaveLength(1);
    expect(await retryRows()).toEqual([]);
  });

  it('a retry for a url restored since is dropped without persisting it', async () => {
    await image(1);
    await moderatorBlock(1);
    scripted = [202, 500, 500, 500];
    await syncCdnAccess();
    await acceptImage(1);
    await syncCdnAccess();
    expect(callsFor(u(1))).toEqual(['retract', 'allow']);

    const before = calls.length;
    expect(await retryTakedownPersists()).toMatchObject({ queued: 1, skipped: 1 });
    expect(calls.slice(before)).toEqual([]);
    expect(await retryRows()).toEqual([]);
  });

  it('a retry for a deleted takedown resends the retraction it carried', async () => {
    combinedOk.add(GONE);
    await sql`INSERT INTO "JobQueue" ("entityId", "entityType", type, data)
              VALUES (7, 'Image', 'ImageCdnPersistRetry',
                      ${JSON.stringify({ url: GONE, retract: true, purgeEdge: false })}::jsonb)`;
    await retryTakedownPersists();
    expect(calls.map((c) => c.path)).toEqual([
      `/admin/invalidate?imageKey=${GONE}&retractPublicBlobs=true&persist=true`,
    ]);
    expect(purged).toEqual([]);
  });

  it('works before the retry label exists: nothing throws, the miss is logged', async () => {
    const bare = await PGlite.create();
    try {
      await bare.exec(`
        CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
        CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete');
        CREATE TABLE "JobQueue" (
          type "JobQueueType" NOT NULL, "entityType" "EntityType" NOT NULL, "entityId" int NOT NULL,
          "createdAt" timestamp(3) NOT NULL DEFAULT now(), data jsonb,
          PRIMARY KEY ("entityType", "entityId", type)
        );
        CREATE TABLE "Image" (id int PRIMARY KEY, url text, name text, type text);
        CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int, url text);
      `);
      const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const q = Prisma.sql(strings, ...(values as never[]));
        return bare.query(q.text, q.values as unknown[]);
      };
      dbMock.dbWrite.$queryRaw.mockImplementation(
        (async (...a: Parameters<typeof run>) => (await run(...a)).rows) as never
      );
      dbMock.dbWrite.$executeRaw.mockImplementation(
        (async (...a: Parameters<typeof run>) => (await run(...a)).affectedRows ?? 0) as never
      );

      scripted = [500, 500, 500];
      await expect(
        sendTakedownPersistOrRetry(u(1), { retract: false, purgeEdge: true }, { imageId: 1 })
      ).resolves.toBeUndefined();
      expect(errorLogs('takedown-persist-retry-not-queued')).toHaveLength(1);
      await expect(retryTakedownPersists()).resolves.toMatchObject({ queued: 0 });
    } finally {
      await bare.close();
      // Persists for a url this database never retracted; the file-wide check reads the main one.
      calls.length = 0;
    }
  });
});

describe('takedown persist retry scope', () => {
  it('drops a sync retry for a url restored and then deleted by its owner', async () => {
    await image(1);
    await moderatorBlock(1);
    scripted = [202, 500, 500, 500];
    await syncCdnAccess();
    await acceptImage(1);
    await syncCdnAccess();
    // The owner deletes it; the url has no image row left, but this was never a hard delete.
    await sql`DELETE FROM "Image" WHERE id = 1`;
    expect(await retryRows()).toHaveLength(1);

    const before = calls.length;
    expect(await retryTakedownPersists()).toMatchObject({ queued: 1, skipped: 1 });
    expect(calls.slice(before)).toEqual([]);
    expect(purged).toEqual([]);
  });
});

describe('persist after a takedown hard delete', () => {
  it('sends one persist per deleted url and queues nothing', async () => {
    expect(
      await persistDeletedTakedowns([
        { id: 1, url: u(1) },
        { id: 2, url: u(2) },
      ])
    ).toEqual({ sent: 2, queued: 0, skipped: 0, notAttempted: 0 });
    expect(calls.map((c) => c.path)).toEqual([
      `/admin/invalidate?imageKey=${u(1)}&persist=true`,
      `/admin/invalidate?imageKey=${u(2)}&persist=true`,
    ]);
    expect(await retryRows()).toEqual([]);
    // Not retracted in this run: the retraction went out with the storage delete.
    calls.length = 0;
  });

  it('leaves a url another image still uses alone', async () => {
    await image(5, { url: SHARED });
    expect(await persistDeletedTakedowns([{ id: 1, url: SHARED }])).toMatchObject({ skipped: 1 });
    expect(calls).toEqual([]);
  });

  it('tries once, then queues a retry that resends the retraction', async () => {
    scripted = [503];
    expect(await persistDeletedTakedowns([{ id: 1, url: u(1) }])).toMatchObject({
      sent: 0,
      queued: 1,
    });
    expect(calls).toHaveLength(1);
    expect(logsOf('warning', 'takedown-persist-failed')).toEqual([
      expect.objectContaining({ imageIds: [1], imageKey: u(1) }),
    ]);
    expect(errorLogs('takedown-persist-budget-spent')).toEqual([]);
    expect(await retryRows()).toEqual([
      { entityId: 1, data: { url: u(1), retract: true, purgeEdge: false } },
    ]);
    calls.length = 0;
  });

  it('sends nothing past its time budget, and queues the rest', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, url: u(i + 1) }));
    const started = Date.now();
    expect(await persistDeletedTakedowns(rows, { budgetMs: 0 })).toEqual({
      sent: 0,
      queued: 30,
      skipped: 0,
      notAttempted: 30,
    });
    expect(calls).toEqual([]);
    // One error for the run, the rows at warn.
    expect(errorLogs('takedown-persist-budget-spent')).toEqual([
      expect.objectContaining({ notAttempted: 30 }),
    ]);
    expect(errorLogs('takedown-persist-failed')).toEqual([]);
    expect(logsOf('warning', 'takedown-persist-failed')).toHaveLength(30);
    expect(await retryRows()).toHaveLength(30);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('the persist retry, as the job runs it', () => {
  const queueRetry = (id: number, url: string) =>
    sql`INSERT INTO "JobQueue" ("entityId", "entityType", type, data)
        VALUES (${id}, 'Image', 'ImageCdnPersistRetry',
                ${JSON.stringify({ url, retract: false, purgeEdge: true })}::jsonb)`;

  it('cdn-access-sync sends and drains a queued retry', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    expect(persistsFor(u(1))).toHaveLength(1);
    await queueRetry(1, u(1));

    await cdnAccessSync.run({}).result;
    expect(persistsFor(u(1))).toHaveLength(2);
    expect(purged).toHaveLength(2);
    expect(await retryRows()).toEqual([]);
  });

  it('leaves a row whose url another run holds, and counts it busy', async () => {
    await image(1);
    await moderatorBlock(1);
    await syncCdnAccess();
    await queueRetry(1, u(1));
    await sql`INSERT INTO "ImageCdnAccessClaim" (url, token, "claimedUntil")
              VALUES (${u(1)}, gen_random_uuid(), now() + interval '5 minutes')`;
    const before = calls.length;

    const totals = await retryTakedownPersists();
    expect(totals).toEqual({ queued: 1, sent: 0, skipped: 0, failed: 0, busy: 1 });
    expect(Object.values(totals).every((n) => Number.isInteger(n))).toBe(true);
    expect(calls.slice(before)).toEqual([]);
    expect(await retryRows()).toHaveLength(1);
  });
});
