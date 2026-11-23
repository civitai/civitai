import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
}));

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

// spendTextScanRetry: bumps retryCount on the same fake rows the lookup mock reads.
dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async (args: {
  where: { entityType: { in: string[] }; entityId: number; status: { not: string } };
  data: { retryCount: { increment: number } };
}) => ({
  count:
    (
      await holder.db.query(
        `UPDATE "EntityModeration" SET "retryCount" = "retryCount" + $1
         WHERE "entityType" = ANY($2) AND "entityId" = $3 AND status <> $4`,
        [
          args.data.retryCount.increment,
          args.where.entityType.in,
          args.where.entityId,
          args.where.status.not,
        ]
      )
    ).affectedRows ?? 0,
})) as never);

const adapter = await import('~/server/services/service-deal-review-moderation.adapter');
const { setServiceDealReviewHidden } = await import(
  '~/server/services/creator-service-deal-review.service'
);
const { getActiveTextScanPrompts } = await import('~/server/services/text-scan/prompt');
const { resetTextScanRolloutCache } = await import('~/server/services/text-scan/mode');
/** The csam gate and its prompt, which decide whether a review scan can ask every label. */
const csamAskable = ({ gate = 'review', prompt = 'CSAM DEF' } = {}) => {
  redisMock.sysRedis.hGetAll.mockResolvedValue((gate ? { csam: gate } : {}) as never);
  resetTextScanRolloutCache();
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue({
    'label:csam': { id: 3, key: 'label:csam', content: prompt },
  } as never);
};
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { reconcileServiceDealReviews } = await import(
  '~/server/services/creator-service-deal-review-reconcile'
);
const rescanUnsubmitted = () => reconcileServiceDealReviews({ limit: 10 });
const { loadServiceDealReviewSubjects } = await import(
  '~/server/services/text-scan/profiles/service-deal-review.profile'
);
const { getTextScanProfile, registerTextScanProfile } = await import(
  '~/server/services/text-scan/profiles'
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
  everyLabel = true,
  workflowId = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r',
  text = type === 'ServiceDealReview' ? COMMENT : REPLY,
}: {
  type?: 'ServiceDealReview' | 'ServiceDealReviewReply';
  level?: number;
  csam?: boolean;
  /** false: the verdict answers nsfw alone. */
  everyLabel?: boolean;
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
      csam: everyLabel ? { detected: csam, reason: 'r' } : undefined,
      triggeredLabels: csam ? ['csam'] : [],
      nsfwLevel: level,
    },
    subject,
    textHash: textScanTextHash(subject),
  });
};
const replyScan = (opts: Parameters<typeof textScan>[0] = {}) =>
  textScan({ ...opts, type: 'ServiceDealReviewReply' });

const NSFW_ONLY = { nsfw: { level: 'none', reason: 'r' } };
const EVERY_LABEL = { ...NSFW_ONLY, csam: { detected: false, reason: 'r' } };

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
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", blocked, "nsfwLevel", result)
       VALUES ('ServiceDealReview', $1, 'wf-new', false, 4, $2::jsonb)`,
      [REVIEW, JSON.stringify({ version: 1, labels: EVERY_LABEL })]
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
      [REVIEW, JSON.stringify({ version: 1, textHash, labels: EVERY_LABEL }), labels]
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

describe('a verdict that does not answer every label the profile requires', () => {
  const TYPES = ['ServiceDealReview', 'ServiceDealReviewReply'] as const;
  const cols = {
    ServiceDealReview: { status: 'scanStatus', workflow: 'scanWorkflowId', wf: 'wf-c' },
    ServiceDealReviewReply: {
      status: 'sellerReplyScanStatus',
      workflow: 'sellerReplyScanWorkflowId',
      wf: 'wf-r',
    },
  } as const;
  /** The text's status and recorded check: Pending with none is what the reconcile resends. */
  const state = async (type: (typeof TYPES)[number]) =>
    (
      await q<{ status: string; workflow: string | null }>(
        `SELECT "${cols[type].status}"::text AS status, "${cols[type].workflow}" AS workflow
         FROM "ServiceDealReview" WHERE id = $1`,
        [REVIEW]
      )
    )[0];
  const RESENDABLE = { status: 'Pending', workflow: null };

  it.each(TYPES)('%s: its result shows nothing and the text is sent again', async (type) => {
    await seed(R);
    await textScan({ type, everyLabel: false });
    expect(await state(type)).toEqual(RESENDABLE);
    // The same result answering every label shows it.
    await q(`UPDATE "ServiceDealReview" SET "${cols[type].workflow}" = $1`, [cols[type].wf]);
    await textScan({ type });
    expect((await state(type)).status).toBe('Scanned');
  });

  it.each(TYPES)(
    '%s: a result that landed before its check was recorded shows nothing',
    async (type) => {
      await seed(R);
      await q(`UPDATE "ServiceDealReview" SET "${cols[type].workflow}" = NULL`);
      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", blocked, "nsfwLevel", result)
         VALUES ($1, $2, 'wf-new', false, 1, $3::jsonb)`,
        [type, REVIEW, JSON.stringify({ version: 1, labels: NSFW_ONLY })]
      );
      await adapter.scanServiceDealReviewText(type, REVIEW, submitCheck);
      expect(await state(type)).toEqual(RESENDABLE);
    }
  );

  it.each(TYPES)('%s: a stored verdict for unchanged text shows nothing', async (type) => {
    await seed(R);
    await q(`UPDATE "ServiceDealReview" SET "${cols[type].workflow}" = NULL`);
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", result, "nsfwLevel")
       VALUES ($1, $2, $3::jsonb, 1)`,
      [
        type,
        REVIEW,
        JSON.stringify({
          version: 1,
          textHash: textScanTextHash((await loadSubject(type))!),
          labels: NSFW_ONLY,
        }),
      ]
    );
    const unchanged = vi.fn(async (args: { onActiveSkip?: (r: 'unchanged') => Promise<void> }) => {
      await args.onActiveSkip?.('unchanged');
      return null;
    });
    await adapter.scanServiceDealReviewText(type, REVIEW, unchanged as never);
    expect(await state(type)).toEqual(RESENDABLE);
  });

  it.each(TYPES)('%s: the requirement holds whatever the profile registry holds', async (type) => {
    const registered = getTextScanProfile(type)!;
    // A registry entry without the requirement, as if the review profile had never loaded.
    registerTextScanProfile({ entityType: type, labels: ['nsfw'], load: registered.load });
    try {
      await seed(R);
      await textScan({ type, everyLabel: false });
      expect(await state(type)).toEqual(RESENDABLE);

      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", result, "nsfwLevel")
           VALUES ($1, $2, $3::jsonb, 1)`,
        [
          type,
          REVIEW,
          JSON.stringify({
            version: 1,
            textHash: textScanTextHash((await loadSubject(type))!),
            labels: NSFW_ONLY,
          }),
        ]
      );
      const unchanged = vi.fn(
        async (args: { onActiveSkip?: (r: 'unchanged') => Promise<void> }) => {
          await args.onActiveSkip?.('unchanged');
          return null;
        }
      );
      await adapter.scanServiceDealReviewText(type, REVIEW, unchanged as never);
      expect(await state(type)).toEqual(RESENDABLE);
    } finally {
      registerTextScanProfile(registered);
    }
  });

  it.each(TYPES)(
    '%s: a scan that could not be sent leaves failed text for the reconcile, not stranded',
    async (type) => {
      await seed(R);
      await q(`UPDATE "ServiceDealReview" SET "${cols[type].status}" = 'Error'`);
      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", status) VALUES ($1, $2, 'Failed')`,
        [type, REVIEW]
      );
      const incomplete = vi.fn(
        async (args: { onActiveSkip?: (r: 'incomplete') => Promise<void> }) => {
          await args.onActiveSkip?.('incomplete');
          return null;
        }
      );
      await adapter.scanServiceDealReviewText(type, REVIEW, incomplete as never);
      expect(await state(type)).toEqual(RESENDABLE);
      // Its failed check row is spent toward its limit, or the retry job would reselect it forever.
      expect(
        (
          await q<{ retryCount: number }>(
            `SELECT "retryCount" FROM "EntityModeration" WHERE "entityType" = $1`,
            [type]
          )
        )[0]
      ).toEqual({ retryCount: 1 });
    }
  );
});

describe('a verdict that cannot settle its text is left to the retry job, within its limit', () => {
  const TYPES = ['ServiceDealReview', 'ServiceDealReviewReply'] as const;
  const cols = {
    ServiceDealReview: { status: 'scanStatus', workflow: 'scanWorkflowId', text: 'comment' },
    ServiceDealReviewReply: {
      status: 'sellerReplyScanStatus',
      workflow: 'sellerReplyScanWorkflowId',
      text: 'sellerReply',
    },
  } as const;
  const state = async (type: (typeof TYPES)[number]) =>
    (
      await q<{ status: string; workflow: string | null }>(
        `SELECT "${cols[type].status}"::text AS status, "${cols[type].workflow}" AS workflow
         FROM "ServiceDealReview" WHERE id = $1`,
        [REVIEW]
      )
    )[0];
  const checkRow = async (type: (typeof TYPES)[number]) =>
    (
      await q<{ status: string; retryCount: number }>(
        `SELECT status, "retryCount" FROM "EntityModeration" WHERE "entityType" = $1 AND "entityId" = $2`,
        [type, REVIEW]
      )
    )[0];
  /** The retry job's own selection: a failed check row with retries left. */
  const retryJobSelects = async (type: (typeof TYPES)[number]) => {
    const row = await checkRow(type);
    return row?.status === 'Failed' && row.retryCount < TEXT_MODERATION_RETRY_LIMIT;
  };
  /** A check the retry job sent recorded its verdict: the row is Succeeded, its retries kept. */
  const recordCheck = async (type: (typeof TYPES)[number], workflowId: string) => {
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", status, result)
       VALUES ($1, $2, $3, 'Succeeded', $4::jsonb)
       ON CONFLICT ("entityType", "entityId") DO UPDATE SET "workflowId" = $3, status = 'Succeeded'`,
      [type, REVIEW, workflowId, JSON.stringify({ version: 1, labels: NSFW_ONLY })]
    );
    await q(`UPDATE "ServiceDealReview" SET "${cols[type].workflow}" = $1`, [workflowId]);
  };
  beforeEach(() => csamAskable());
  const spentLogs = () =>
    loggingMock.logToAxiom.mock.calls.filter(([entry]) =>
      String((entry as { message?: string }).message).startsWith('retries spent')
    );

  it.each(TYPES)(
    '%s: verdicts that never answer every label stop being sent at the limit, and never show the text',
    async (type) => {
      await seed(R);
      let sent = 0;
      for (let attempt = 1; attempt <= TEXT_MODERATION_RETRY_LIMIT + 3; attempt++) {
        if (attempt > 1 && !(await retryJobSelects(type))) break;
        sent++;
        await recordCheck(type, `wf-${attempt}`);
        await textScan({ type, everyLabel: false, workflowId: `wf-${attempt}` });
        expect(await state(type)).toEqual({ status: 'Pending', workflow: null });
      }
      expect(sent).toBe(TEXT_MODERATION_RETRY_LIMIT);
      expect(await checkRow(type)).toEqual({
        status: 'Failed',
        retryCount: TEXT_MODERATION_RETRY_LIMIT,
      });
      expect(spentLogs()).toHaveLength(1);
      expect(spentLogs()[0][0]).toMatchObject({
        type: 'error',
        reviewId: REVIEW,
        entityType: type,
        payload: { labels: ['csam'] },
      });
    }
  );

  it('a verdict for an older check spends nothing on the newer check', async () => {
    await seed(R);
    await recordCheck('ServiceDealReview', 'wf-newer');
    await textScan({ everyLabel: false, workflowId: 'wf-older' });
    expect(await checkRow('ServiceDealReview')).toEqual({ status: 'Succeeded', retryCount: 0 });
  });

  it('the reconcile leaves text whose check row the retry job holds, and only that text', async () => {
    await seed(R);
    await q(
      `UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL, "sellerReplyScanWorkflowId" = NULL,
         "updatedAt" = now() - interval '1 hour'`
    );
    await q(
      `INSERT INTO "EntityModeration" ("entityType", "entityId", status, "retryCount")
       VALUES ('ServiceDealReview', $1, 'Failed', $2)`,
      [REVIEW, TEXT_MODERATION_RETRY_LIMIT]
    );
    const rescans = vi.spyOn(adapter, 'scanServiceDealReviewText').mockResolvedValue(undefined);
    try {
      await rescanUnsubmitted();
      expect(rescans.mock.calls).toEqual([['ServiceDealReviewReply', REVIEW]]);
    } finally {
      rescans.mockRestore();
    }
  });

  it.each([
    ['csam gate closed', { gate: '' }],
    ['csam prompt blank', { prompt: ' ' }],
  ])('%s: the reconcile sends no review text, and says so once', async (_cause, askable) => {
    await seed(R);
    await q(
      `UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL, "sellerReplyScanWorkflowId" = NULL,
         "updatedAt" = now() - interval '1 hour'`
    );
    csamAskable(askable);
    const rescans = vi.spyOn(adapter, 'scanServiceDealReviewText').mockResolvedValue(undefined);
    try {
      await rescanUnsubmitted();
      expect(rescans).not.toHaveBeenCalled();
    } finally {
      rescans.mockRestore();
    }
    const said = loggingMock.logToAxiom.mock.calls.filter(([entry]) =>
      String((entry as { message?: string }).message).startsWith('review text scan cannot ask')
    );
    expect(said).toHaveLength(1);
    expect(said[0][0]).toMatchObject({ type: 'warning' });
  });

  it.each(TYPES)(
    '%s: text whose check failed while its review was hidden is checked again on restore, and can show',
    async (type) => {
      await seed(R);
      const wf = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r';
      await q(`UPDATE "ServiceDealReview" SET "hiddenAt" = now()`);
      await (type === 'ServiceDealReview'
        ? adapter.serviceDealReviewModerationAdapter
        : adapter.serviceDealReviewReplyModerationAdapter
      ).applyFailure!({ entityId: REVIEW, workflowId: wf } as never);
      // The retry job found the review hidden and parked the row at its limit.
      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", status, "retryCount")
         VALUES ($1, $2, $3, 'Failed', $4)`,
        [type, REVIEW, wf, TEXT_MODERATION_RETRY_LIMIT]
      );
      const real = adapter.scanServiceDealReviewText;
      const scans = vi
        .spyOn(adapter, 'scanServiceDealReviewText')
        .mockImplementation((t, id) => real(t, id, submitCheck));
      try {
        expect(
          await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: false })
        ).toBe(true);
      } finally {
        scans.mockRestore();
      }
      expect(await state(type)).toEqual({ status: 'Pending', workflow: 'wf-new' });
      await recordCheck(type, 'wf-new');
      await textScan({ type, workflowId: 'wf-new' });
      expect((await state(type)).status).toBe('Scanned');
    }
  );

  it('a failed read of the labels: the reconcile sends no review text, says so once, and the job runs on', async () => {
    await seed(R);
    await q(
      `UPDATE "ServiceDealReview" SET "scanWorkflowId" = NULL, "sellerReplyScanWorkflowId" = NULL,
         "updatedAt" = now() - interval '1 hour'`
    );
    vi.mocked(getActiveTextScanPrompts).mockRejectedValue(new Error('prompts unreadable'));
    const rescans = vi.spyOn(adapter, 'scanServiceDealReviewText').mockResolvedValue(undefined);
    try {
      await expect(rescanUnsubmitted()).resolves.toMatchObject({
        rescanned: 0,
        synced: 0,
        eventsWithoutReview: 0,
      });
      expect(rescans).not.toHaveBeenCalled();
    } finally {
      rescans.mockRestore();
    }
    const said = loggingMock.logToAxiom.mock.calls.filter(([entry]) =>
      String((entry as { message?: string }).message).startsWith('review text scan cannot ask')
    );
    expect(said).toHaveLength(1);
  });

  it.each(TYPES)(
    '%s: text whose verdict landed while its review was hidden is checked again on restore, and can show',
    async (type) => {
      await seed(R);
      const wf = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r';
      expect(
        await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: true })
      ).toBe(true);
      // The callback found the review not public: its row Failed, the text left Pending on its check.
      // Then the retry job found the review hidden and parked the row at its limit.
      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", status, "retryCount")
         VALUES ($1, $2, $3, 'Failed', $4)`,
        [type, REVIEW, wf, TEXT_MODERATION_RETRY_LIMIT]
      );
      expect(await state(type)).toEqual({ status: 'Pending', workflow: wf });
      const real = adapter.scanServiceDealReviewText;
      const scans = vi
        .spyOn(adapter, 'scanServiceDealReviewText')
        .mockImplementation((t, id) => real(t, id, submitCheck));
      try {
        expect(
          await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: false })
        ).toBe(true);
        expect(scans.mock.calls).toEqual([[type, REVIEW]]);
      } finally {
        scans.mockRestore();
      }
      expect(await state(type)).toEqual({ status: 'Pending', workflow: 'wf-new' });
      await recordCheck(type, 'wf-new');
      await textScan({ type, workflowId: 'wf-new' });
      expect((await state(type)).status).toBe('Scanned');
    }
  );

  it.each(TYPES)(
    "%s: an older check's failure does not send text back on restore while its own check is out",
    async (type) => {
      await seed(R);
      const wf = type === 'ServiceDealReview' ? 'wf-c' : 'wf-r';
      await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: true });
      await q(
        `INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", status, "retryCount")
         VALUES ($1, $2, 'wf-older', 'Failed', $3)`,
        [type, REVIEW, TEXT_MODERATION_RETRY_LIMIT]
      );
      const scans = vi.spyOn(adapter, 'scanServiceDealReviewText').mockResolvedValue(undefined);
      try {
        await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: false });
        expect(scans).not.toHaveBeenCalled();
      } finally {
        scans.mockRestore();
      }
      expect(await state(type)).toEqual({ status: 'Pending', workflow: wf });
    }
  );

  it('a check still in flight when its review is restored is left to land', async () => {
    await seed(R);
    await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: true });
    await recordCheck('ServiceDealReview', 'wf-c');
    await q(`UPDATE "EntityModeration" SET status = 'Pending'`);
    const scans = vi.spyOn(adapter, 'scanServiceDealReviewText').mockResolvedValue(undefined);
    try {
      await setServiceDealReviewHidden({ reviewId: REVIEW, moderatorId: SELLER, hidden: false });
      expect(scans).not.toHaveBeenCalled();
    } finally {
      scans.mockRestore();
    }
    expect(await state('ServiceDealReview')).toEqual({ status: 'Pending', workflow: 'wf-c' });
  });

  it('an edit to text past its limit is scanned again', async () => {
    await seed(R);
    await recordCheck('ServiceDealReview', 'wf-1');
    await q(`UPDATE "EntityModeration" SET status = 'Failed', "retryCount" = $1`, [
      TEXT_MODERATION_RETRY_LIMIT,
    ]);
    // What the review's writer does on an edit: the text back to Pending, then its check.
    await q(
      `UPDATE "ServiceDealReview" SET comment = 'Edited', "scanStatus" = 'Pending', "scanWorkflowId" = NULL`
    );
    await adapter.scanServiceDealReviewText('ServiceDealReview', REVIEW, submitCheck);
    expect(submitCheck).toHaveBeenCalledTimes(1);
    expect(await state('ServiceDealReview')).toEqual({ status: 'Pending', workflow: 'wf-new' });
  });
});
