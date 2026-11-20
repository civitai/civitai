import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The content check of a service deal review's two texts, the buyer's comment and the seller's
 * reply, run on an in-process Postgres with the real migrations. Only the check's submit is faked.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
/** The content check's submit, passed in: it answers with the check's workflow. */
const submitCheck = vi.fn(async (): Promise<{ id?: string | null } | null> => ({ id: 'wf-new' }));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => {
    const raw = pgliteRaw(tx as unknown as PGlite);
    return fn({ $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw });
  })) as never);
// The Prisma reads the adapter makes, answered from the same rows.
dbMock.dbWrite.textScanHold.findMany.mockImplementation(
  (async (args: { where: { entityType: string; entityId: number } }) =>
    (
      await holder.db.query(
        `SELECT status::text AS status, "textHash", meta FROM "TextScanHold"
       WHERE "entityType" = $1 AND "entityId" = $2 AND label = 'csam'`,
        [args.where.entityType, args.where.entityId]
      )
    ).rows) as never
);
const emRow = async (entityType: string, entityId: number, workflowId?: string) =>
  (
    await holder.db.query(
      `SELECT status, blocked, "nsfwLevel", "triggeredLabels", result FROM "EntityModeration"
       WHERE "entityType" = $1 AND "entityId" = $2 AND ($3::text IS NULL OR "workflowId" = $3)`,
      [entityType, entityId, workflowId ?? null]
    )
  ).rows[0] ?? null;
dbMock.dbWrite.entityModeration.findUnique.mockImplementation((async (args: {
  where: { entityType_entityId: { entityType: string; entityId: number } };
}) =>
  emRow(
    args.where.entityType_entityId.entityType,
    args.where.entityType_entityId.entityId
  )) as never);
dbMock.dbWrite.entityModeration.findFirst.mockImplementation((async (args: {
  where: { entityType: string; entityId: number; workflowId: string; status: string };
}) => {
  const row = await emRow(args.where.entityType, args.where.entityId, args.where.workflowId);
  return row && (row as { status: string }).status === args.where.status ? row : null;
}) as never);

const adapter = await import('~/server/services/service-deal-review-moderation.adapter');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { loadServiceDealReviewSubjects } = await import(
  '~/server/services/text-scan/profiles/service-deal-review.profile'
);
const loadSubject = async (
  type: 'ServiceDealReview' | 'ServiceDealReviewReply' = 'ServiceDealReview'
) => (await loadServiceDealReviewSubjects(type, [REVIEW])).get(REVIEW);

const MIGRATIONS = [
  '20261016150000_text_scan_hold',
  '20261025120000_creator_services_foundation',
  '20261028130000_service_deal_event_reason_code',
  '20261028140000_creator_service_deal_file_state',
  '20261028150000_creator_service_max_nsfw_level',
  '20261028170000_creator_service_offering_takedown',
  '20270106120000_service_offering_content_scan',
  '20271120100000_service_deal_reviewed_happy',
  '20271120100100_service_deal_reviews',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const { PG13, R, X } = NsfwLevel;
const SELLER = 1;
const BUYER = 2;
const REVIEW = 1;
const COMMENT = 'Lovely work, thank you';
const REPLY = 'Glad you liked it';

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

const statuses = async () =>
  (
    await q<{ comment: string; reply: string | null }>(
      `SELECT "scanStatus"::text AS comment, "sellerReplyScanStatus"::text AS reply
       FROM "ServiceDealReview" WHERE id = $1`,
      [REVIEW]
    )
  )[0];

/** A review of a deal at `dealLevel`, its comment and reply each waiting on check `wf-c` / `wf-r`. */
const seed = async (dealLevel: number) => {
  await q(
    `INSERT INTO "ServiceOffering" (id, "sellerId", title, description, price, "deliveryDays", "declaredNsfwLevel", "maxNsfwLevel", "updatedAt")
     VALUES (1, $1, 'Portraits', 'desc', 500, 3, $2, $2, now())`,
    [SELLER, dealLevel]
  );
  await q(
    `INSERT INTO "ServiceDeal" (id, "offeringId", "buyerId", "sellerId", price, "buzzType", "revisionsIncluded",
       "deliveryDays", "previewKind", "requestText", "maxNsfwLevel", "updatedAt")
     VALUES (1, 1, $1, $2, 500, 'yellow', 1, 3, 'None', 'please', $3, now())`,
    [BUYER, SELLER, dealLevel]
  );
  await q(
    `INSERT INTO "ServiceDealReview" (id, "dealId", "offeringId", "sellerId", "buyerId", verdict, comment,
       "scanStatus", "scanWorkflowId", "sellerReply", "sellerReplyAt", "sellerReplyScanStatus",
       "sellerReplyScanWorkflowId", "editableUntil", "updatedAt")
     VALUES ($1, 1, 1, $2, $3, 'Happy', $4, 'Pending', 'wf-c', $5, now(), 'Pending', 'wf-r', now(), now())`,
    [REVIEW, SELLER, BUYER, COMMENT, REPLY]
  );
};

const xguardResult = (
  type: 'ServiceDealReview' | 'ServiceDealReviewReply',
  {
    workflowId = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r',
    blocked = false,
    nsfw = false,
  } = {}
) =>
  (type === 'ServiceDealReview'
    ? adapter.serviceDealReviewModerationAdapter
    : adapter.serviceDealReviewReplyModerationAdapter
  ).applyResult!({
    entityId: REVIEW,
    workflowId,
    blocked,
    triggeredLabels: nsfw ? ['nsfw'] : [],
    output: {} as never,
  });

const textScan = ({
  type = 'ServiceDealReview',
  level = NsfwLevel.PG,
  csam = false,
  workflowId = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r',
  text = type === 'ServiceDealReview' ? COMMENT : REPLY,
}: {
  type?: 'ServiceDealReview' | 'ServiceDealReviewReply';
  level?: number;
  csam?: boolean;
  workflowId?: string;
  text?: string;
} = {}) => {
  const subject = { userId: BUYER, declared: {}, fields: [{ heading: 'Review', text }] };
  return (
    type === 'ServiceDealReview'
      ? adapter.serviceDealReviewModerationAdapter
      : adapter.serviceDealReviewReplyModerationAdapter
  ).applyTextScan!({
    entityId: REVIEW,
    workflowId,
    outcome: {
      nsfw: { detectedLevel: level } as never,
      csam: csam ? { detected: true, reason: 'r' } : undefined,
      triggeredLabels: csam ? ['csam'] : [],
      nsfwLevel: level,
    },
    subject,
    textHash: textScanTextHash(subject),
  });
};
const replyScan = (opts: Parameters<typeof textScan>[0] = {}) =>
  textScan({ ...opts, type: 'ServiceDealReviewReply' });

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false, "createdAt" timestamp(3) NOT NULL DEFAULT now() - interval '1 year');
    CREATE TABLE "Report" (id serial PRIMARY KEY);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, "nsfwLevel" int NOT NULL DEFAULT 0,
      "tosViolation" boolean NOT NULL DEFAULT false);
    INSERT INTO "User" (id) VALUES (1), (2);
    CREATE TABLE "EntityModeration" ("entityType" text NOT NULL, "entityId" int NOT NULL, blocked boolean,
      "triggeredLabels" text[] NOT NULL DEFAULT '{}', result jsonb, "nsfwLevel" int, "workflowId" text,
      status text NOT NULL DEFAULT 'Succeeded', "retryCount" int NOT NULL DEFAULT 0,
      "updatedAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("entityType", "entityId"));
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  submitCheck.mockResolvedValue({ id: 'wf-new' });
  await holder.db.exec(`
    TRUNCATE "ServiceDealReview", "ServiceDeal", "ServiceOffering", "EntityModeration", "TextScanHold"
      RESTART IDENTITY CASCADE;
  `);
});

describe('a review text check', () => {
  it('shows text at or below the deal level and never text above it', async () => {
    await seed(PG13);
    await textScan();
    await replyScan({ level: R });
    expect(await statuses()).toEqual({ comment: 'Scanned', reply: 'Blocked' });
  });

  it('reads a text-scan level against the deal, so R text shows on an R deal and X text does not', async () => {
    await seed(R);
    await textScan({ level: R });
    expect((await statuses()).comment).toBe('Scanned');

    await q(`UPDATE "ServiceDealReview" SET "scanStatus" = 'Pending'`);
    await textScan({ level: X });
    expect((await statuses()).comment).toBe('Blocked');
  });

  it('never shows text the fallback check passed: review text needs the text scan, with csam', async () => {
    await seed(R);
    await xguardResult('ServiceDealReview');
    await xguardResult('ServiceDealReviewReply');
    expect(await statuses()).toEqual({ comment: 'Pending', reply: 'Pending' });
  });

  it('records no check while the text scan is off for reviews, so the text stays hidden', async () => {
    await seed(R);
    await q(`UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL`);
    // With the text scan off, the route falls back to the check this adapter declines.
    const off = vi.fn(async (args: { xguard: () => Promise<{ id?: string | null } | null> }) =>
      args.xguard()
    );
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, off as never);
    const [row] = await q<{ scanWorkflowId: string | null; publishedAt: Date | null }>(
      `SELECT "scanWorkflowId", "publishedAt" FROM "ServiceDealReview"`
    );
    expect(row).toEqual({ scanWorkflowId: null, publishedAt: null });
    expect((await statuses()).comment).toBe('Pending');
  });

  it('blocks text the check blocked, whatever its level', async () => {
    await seed(X);
    await xguardResult('ServiceDealReview', { blocked: true });
    expect((await statuses()).comment).toBe('Blocked');
  });

  it('applies no result from a check for text since replaced, and settles each text on its own', async () => {
    await seed(R);
    await xguardResult('ServiceDealReview', { workflowId: 'wf-old' });
    await textScan({ workflowId: 'wf-old' });
    expect(await statuses()).toEqual({ comment: 'Pending', reply: 'Pending' });
    await replyScan();
    expect(await statuses()).toEqual({ comment: 'Pending', reply: 'Scanned' });
  });

  it('marks a failed check Error only for its own check while Pending', async () => {
    await seed(R);
    const fail = (workflowId: string) =>
      adapter.serviceDealReviewModerationAdapter.applyFailure!({
        entityId: REVIEW,
        workflowId,
        status: 'failed',
      });
    await fail('wf-old');
    expect((await statuses()).comment).toBe('Pending');
    await fail('wf-c');
    expect((await statuses()).comment).toBe('Error');
    // A later passing check still shows it.
    await textScan();
    expect((await statuses()).comment).toBe('Scanned');
  });

  it('records a submitted check only for the text it was submitted for', async () => {
    await seed(R);
    await q(`UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL`);
    submitCheck.mockImplementationOnce(async () => {
      // The buyer edits while the check is being submitted.
      await q(`UPDATE "ServiceDealReview" SET comment = 'Edited'`);
      return { id: 'wf-stale' };
    });
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, submitCheck);
    const [row] = await q<{ scanWorkflowId: string | null }>(
      `SELECT "scanWorkflowId" FROM "ServiceDealReview"`
    );
    expect(row.scanWorkflowId).toBeNull();

    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, submitCheck);
    expect(
      (await q<{ scanWorkflowId: string }>(`SELECT "scanWorkflowId" FROM "ServiceDealReview"`))[0]
        .scanWorkflowId
    ).toBe('wf-new');
  });

  it('applies a result that landed before its check was recorded', async () => {
    await seed(PG13);
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", blocked, "nsfwLevel")
       VALUES ('ServiceDealReview', $1, 'wf-new', false, 4)`,
      [REVIEW]
    );
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, submitCheck);
    expect((await statuses()).comment).toBe('Blocked');
  });
});

describe('what a settled check does to the review', () => {
  const publishedAt = async () =>
    (await q<{ publishedAt: Date | null }>(`SELECT "publishedAt" FROM "ServiceDealReview"`))[0]
      .publishedAt;

  it('shows a happy review once its comment passes, and unshows it when a moderator removes the text', async () => {
    await seed(R);
    expect(await publishedAt()).toBeNull();
    await textScan();
    expect(await publishedAt()).not.toBeNull();
    await adapter.blockServiceDealReviewText('ServiceDealReview', REVIEW);
    expect(await publishedAt()).toBeNull();
  });

  it("leaves the review's showing to its comment, not the seller's reply", async () => {
    await seed(R);
    await replyScan();
    expect(await publishedAt()).toBeNull();
  });
});

describe('a stored verdict for unchanged text', () => {
  const hashOf = (text: string) =>
    textScanTextHash({ declared: {}, fields: [{ heading: 'Review', text }] });
  const storedVerdict = (textHash: string, labels = '{}') =>
    q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", result, "nsfwLevel", "triggeredLabels")
       VALUES ('ServiceDealReview', $1, $2::jsonb, 1, $3::text[])`,
      [REVIEW, JSON.stringify({ version: 1, textHash }), labels]
    );
  // The check skips text it has already judged and hands back the stored verdict.
  const unchanged = vi.fn(async (args: { onActiveSkip?: (r: 'unchanged') => Promise<void> }) => {
    await args.onActiveSkip?.('unchanged');
    return null;
  });

  it('settles text whose stored verdict is about it', async () => {
    await seed(R);
    await storedVerdict(textScanTextHash((await loadSubject())!));
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, unchanged as never);
    expect((await statuses()).comment).toBe('Scanned');
  });

  it('leaves text unshown when the stored verdict is about other text', async () => {
    await seed(R);
    await storedVerdict(hashOf('something else'));
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, unchanged as never);
    expect((await statuses()).comment).toBe('Pending');
  });

  it('blocks text the csam queue still holds', async () => {
    await seed(R);
    const hash = textScanTextHash((await loadSubject())!);
    await storedVerdict(hash, '{csam}');
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, unchanged as never);
    expect((await statuses()).comment).toBe('Blocked');
  });
});

describe('a csam verdict on review text', () => {
  const holds = () =>
    q<{ status: string; userId: number; entityType: string }>(
      `SELECT status::text AS status, "userId", "entityType" FROM "TextScanHold" ORDER BY id`
    );

  it('holds the text for the csam queue under its author and never shows it', async () => {
    await seed(X);
    await textScan({ csam: true });
    expect((await statuses()).comment).toBe('Blocked');
    expect(await holds()).toEqual([
      { status: 'Pending', userId: BUYER, entityType: 'ServiceDealReview' },
    ]);
  });

  it('keeps the text blocked while the hold is pending, and sends it back to its check once a moderator dismisses it', async () => {
    await seed(X);
    await textScan({ csam: true });
    await adapter.requeueBlockedServiceDealReviewText('ServiceDealReview', REVIEW);
    expect((await statuses()).comment).toBe('Blocked');

    await q(`UPDATE "TextScanHold" SET status = 'Dismissed', meta = '{"decision":"dismiss"}'`);
    await adapter.requeueBlockedServiceDealReviewText('ServiceDealReview', REVIEW);
    expect((await statuses()).comment).toBe('Pending');
  });

  it('holds a reply under the seller, its author, and a comment under the buyer', async () => {
    await seed(R);
    expect((await loadSubject('ServiceDealReviewReply'))?.userId).toBe(SELLER);
    expect((await loadSubject('ServiceDealReview'))?.userId).toBe(BUYER);
  });

  it("a moderator's removal blocks the text and leaves the other text alone", async () => {
    await seed(X);
    await textScan();
    await replyScan();
    await adapter.blockServiceDealReviewText('ServiceDealReviewReply', REVIEW);
    expect(await statuses()).toEqual({ comment: 'Scanned', reply: 'Blocked' });
  });
});
