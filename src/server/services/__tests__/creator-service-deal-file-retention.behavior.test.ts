import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Deal-file retention against the real deal migrations on an in-process Postgres: which files the
 * sweep marks removed, what holds them, and what the purge leaves behind. Storage is faked.
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const s3 = vi.hoisted(() => ({
  purgeObjectVersions: vi.fn(),
  deleteObject: vi.fn(),
  send: vi.fn(),
}));
const flipt = vi.hoisted(() => ({ retentionOn: true }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(
    async (flag: string) => flag === 'service-deal-file-retention' && flipt.retentionOn
  ),
}));
vi.mock('~/utils/s3-utils', () => ({
  getBucket: async () => 'bucket',
  deleteObject: s3.deleteObject,
  getGetUrlByKey: vi.fn(),
  getPutUrl: vi.fn(),
  getImageUploadBackend: async () => ({
    s3: { send: s3.send },
    bucket: 'image-store',
    backend: 'b2',
  }),
  getS3Client: () => ({ send: s3.send }),
  headObject: vi.fn(),
  uploadImageBufferToStore: vi.fn(),
}));
vi.mock('~/utils/s3-purge-versions', () => ({ purgeObjectVersions: s3.purgeObjectVersions }));

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  return { $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const retention = await import('~/server/services/creator-service-deal-file-retention');
const files = await import('~/server/services/creator-service-deal-file.service');
const unpack = await import('~/server/services/creator-service-deal-unpack.service');

const MIGRATIONS = [
  '20261025120000_creator_services_foundation',
  '20261028130000_service_deal_event_reason_code',
  '20261028140000_creator_service_deal_file_state',
  '20261028150000_creator_service_max_nsfw_level',
  '20261028160000_creator_service_deal_file_entries',
  '20261028170000_creator_service_offering_takedown',
  '20261029140000_creator_service_deal_file_delivery',
  '20261128150000_creator_service_final_malware_scan',
  '20261208120000_creator_service_dispute_review',
  '20261224150000_service_deal_file_removed_at',
  '20261224150100_service_deal_file_attachment',
  '20270106120000_service_offering_content_scan',
  '20271118230000_service_deal_file_purge',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const SELLER = 1;
const BUYER = 2;
/** A user with no part in the deal. */
const OTHER = 3;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await holder.db.query<T>(sql, params)).rows;
const daysAgo = (days: number) => `now() - interval '${days} days'`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, username text, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false, meta jsonb);
    CREATE TABLE "UserReport" ("userId" int NOT NULL, "reportId" int NOT NULL);
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TABLE "Report" (id serial PRIMARY KEY, status "ReportStatus" NOT NULL DEFAULT 'Pending',
      "createdAt" timestamp NOT NULL DEFAULT now(), "statusSetAt" timestamp);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      "reportSentAt" timestamp, "archivedAt" timestamp);
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp);
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Appeal" (id serial PRIMARY KEY, "userId" int NOT NULL, status "AppealStatus" NOT NULL);
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text NOT NULL);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 1,
      "tosViolation" boolean NOT NULL DEFAULT false);
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
  await holder.db.exec(`
    ALTER TABLE "Image" ADD COLUMN "userId" int, ADD COLUMN "blockedFor" text;
    ALTER TABLE "CsamReport" ADD COLUMN images jsonb NOT NULL DEFAULT '[]';`);
});

beforeEach(async () => {
  vi.clearAllMocks();
  s3.purgeObjectVersions.mockResolvedValue({ versionsDeleted: 2, remaining: 0 });
  s3.deleteObject.mockResolvedValue(undefined);
  s3.send.mockResolvedValue({ ETag: '"abc123"' });
  await holder.db.exec(`
    TRUNCATE "ServiceDealFilePurge", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering",
      "Report", "UserReport", "CsamReport", "EvidenceHold", "Appeal", "ModActivity", "Image" RESTART IDENTITY CASCADE;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${OTHER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'Image', 'Active', 'Scanned', now());
  `);
});

/** A closed deal `age` days past the start of its clock, with one seller final and one buyer attachment. */
async function closedDeal(
  status: 'Cancelled' | 'Declined' | 'Expired' | 'Completed',
  age: number,
  settled = true
) {
  const completed = status === 'Completed';
  const [deal] = await q<{ id: number }>(
    `INSERT INTO "ServiceDeal" ("offeringId", "buyerId", "sellerId", price, "buzzType", "revisionsIncluded",
       "deliveryDays", "previewKind", status, "requestText", "heldAt", "settledAt", "closedAt",
       "completedAt", "releaseAt", "updatedAt")
     VALUES (1, ${BUYER}, ${SELLER}, 500, 'yellow', 1, 3, 'Image', $1, 'a request', ${daysAgo(
      age + 5
    )},
       ${settled ? daysAgo(age) : 'NULL'}, ${completed ? 'NULL' : daysAgo(age)},
       ${completed ? daysAgo(age + 2) : 'NULL'}, ${completed ? daysAgo(age) : 'NULL'}, now())
     RETURNING id`,
    [status]
  );
  const [final] = await q<{ id: number }>(
    `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "fileName", "mimeType", size, status, "scanStatus", "malwareScanStatus")
     VALUES ($1, 'Final', $2, 'portrait.png', 'image/png', 1234, 'Ready', 'Passed', 'Passed') RETURNING id`,
    [deal.id, `k/${deal.id}/final`]
  );
  const [attachment] = await q<{ id: number }>(
    `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "fileName", "mimeType", size, status, "scanStatus", "malwareScanStatus")
     VALUES ($1, 'Attachment', $2, 'ref.png', 'image/png', 99, 'Ready', 'Passed', 'Passed') RETURNING id`,
    [deal.id, `k/${deal.id}/ref`]
  );
  return { dealId: deal.id, finalId: final.id, attachmentId: attachment.id };
}

/** The sweep with its launch floor long past, so each test sets its own clock. */
const sweep = () => retention.markExpiredDealFiles({ effectiveAt: new Date(0) });

const removed = async (fileId: number) =>
  (
    await q<{ removedAt: Date | null }>(`SELECT "removedAt" FROM "ServiceDealFile" WHERE id = $1`, [
      fileId,
    ])
  )[0]?.removedAt != null;

const kept = async (fileId: number) =>
  (await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).length === 1;

/** The purge, once every download link signed before the files were removed has expired. */
const purge = async () => {
  await q(
    `UPDATE "ServiceDealFile" SET "removedAt" = "removedAt" - interval '10 minutes' WHERE "removedAt" IS NOT NULL`
  );
  return files.purgeRemovedFiles();
};

/** The sweep, then the purge that deletes what it marked and no hold keeps. */
const sweepAndPurge = async () => {
  await sweep();
  return purge();
};

describe('the retention windows', () => {
  it.each(['Cancelled', 'Declined', 'Expired'] as const)(
    "removes a %s deal's files 30 days after it closed, and not a day before",
    async (status) => {
      const early = await closedDeal(status, 29);
      const due = await closedDeal(status, 31);
      expect(await sweep()).toBe(2);
      expect(await removed(early.finalId)).toBe(false);
      expect(await removed(due.finalId)).toBe(true);
      expect(await removed(due.attachmentId)).toBe(true);
    }
  );

  it("removes a completed deal's files 90 days after its dispute window ended, and not a day before", async () => {
    const early = await closedDeal('Completed', 89);
    const due = await closedDeal('Completed', 91);
    await sweep();
    expect(await removed(early.finalId)).toBe(false);
    expect(await removed(due.finalId)).toBe(true);
  });

  it('keeps the files of a deal whose money has not settled, or that is still open', async () => {
    await closedDeal('Cancelled', 60, false);
    const open = await closedDeal('Cancelled', 60);
    await q(`UPDATE "ServiceDeal" SET status = 'Accepted' WHERE id = $1`, [open.dealId]);
    expect(await sweep()).toBe(0);
  });

  it('keeps a closed deal with no close time', async () => {
    await closedDeal('Expired', 200);
    await q(`UPDATE "ServiceDeal" SET "closedAt" = NULL`);
    expect(await sweep()).toBe(0);
  });

  it('marks a closed deal that never held money', async () => {
    const { finalId } = await closedDeal('Declined', 40);
    await q(`UPDATE "ServiceDeal" SET "heldAt" = NULL, "settledAt" = NULL`);
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });
});

describe('the retention off-switch', () => {
  it('marks nothing while the flag is off, and marks once it is on', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    flipt.retentionOn = false;
    try {
      expect(await sweep()).toBe(0);
      expect(await removed(finalId)).toBe(false);
    } finally {
      flipt.retentionOn = true;
    }
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });
});

describe('the launch floor', () => {
  it('gives a deal that closed before launch its full window from launch, and not a day less', async () => {
    const { finalId } = await closedDeal('Cancelled', 60);
    const launch = (days: number) => new Date(Date.now() - days * 86_400_000);
    await retention.markExpiredDealFiles({ effectiveAt: launch(29) });
    expect(await removed(finalId)).toBe(false);
    await retention.markExpiredDealFiles({ effectiveAt: launch(31) });
    expect(await removed(finalId)).toBe(true);
  });
});

describe('a later moderation action restarts the clock', () => {
  it.each([
    [
      'a dispute ruling',
      `UPDATE "ServiceDeal" SET "disputeResolvedAt" = ${daysAgo(
        10
      )}, "disputeResolution" = 'Refund'`,
    ],
    [
      'a takedown of the offering',
      `UPDATE "ServiceOffering" SET status = 'Removed', "removedAt" = ${daysAgo(
        10
      )}, "removedReason" = 'x', "removedById" = 9`,
    ],
  ])('%s', async (_name, sql) => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(sql);
    await sweep();
    expect(await removed(finalId)).toBe(false);
  });
});

describe('a report on the offering', () => {
  it('leaves the original deadline for hiding, and keeps the bytes a window after it was handled', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "Report" (status, "createdAt", "statusSetAt") VALUES ('Actioned', ${daysAgo(
        20
      )}, ${daysAgo(10)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`);
    await sweepAndPurge();
    expect(await removed(finalId)).toBe(true);
    expect(await kept(finalId)).toBe(true);
    await q(`UPDATE "Report" SET "createdAt" = ${daysAgo(40)}, "statusSetAt" = ${daysAgo(31)}`);
    await purge();
    expect(await kept(finalId)).toBe(false);
  });
});

describe('holds', () => {
  const holds: [string, (party: number) => string][] = [
    ['an evidence hold', (p) => `INSERT INTO "EvidenceHold" ("userId") VALUES (${p})`],
    [
      'a moderation report, long sent and archived',
      (p) =>
        `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES (${p}, ${daysAgo(
          800
        )}, ${daysAgo(700)})`,
    ],
    [
      'a moderation report naming them second, long sent and archived',
      (p) =>
        `INSERT INTO "CsamReport" (details, "reportSentAt", "archivedAt") VALUES ('{"secondaryUserId": "${p}"}', ${daysAgo(
          800
        )}, ${daysAgo(700)})`,
    ],
    ['a pending appeal', (p) => `INSERT INTO "Appeal" ("userId", status) VALUES (${p}, 'Pending')`],
    [
      'a minor-safety ban',
      (p) =>
        `UPDATE "User" SET "bannedAt" = now(), meta = '{"banDetails": {"reasonCode": "SexualMinor"}}' WHERE id = ${p}`,
    ],
    [
      'ban notes naming a child-safety report',
      (p) =>
        `UPDATE "User" SET "bannedAt" = now(), meta = '{"banDetails": {"reasonCode": "Harassment", "detailsInternal": "NCMEC report filed"}}' WHERE id = ${p}`,
    ],
    [
      'an image held for review',
      (p) => `INSERT INTO "Image" ("userId", "needsReview") VALUES (${p}, 'csam')`,
    ],
    [
      'a blocked image no sent report lists',
      (p) => `INSERT INTO "Image" ("userId", "blockedFor") VALUES (${p}, 'CSAM')`,
    ],
    [
      'an image listed in a holding report naming someone else',
      (p) =>
        `INSERT INTO "Image" (id, "userId") VALUES (900${p}, ${p}); INSERT INTO "CsamReport" ("userId", images) VALUES (${OTHER}, '[{"id": 900${p}}]')`,
    ],
    [
      'an open report against them',
      (p) =>
        `INSERT INTO "Report" (status) VALUES ('Pending'); INSERT INTO "UserReport" ("userId", "reportId") VALUES (${p}, (SELECT max(id) FROM "Report"))`,
    ],
    [
      'a lost payment dispute',
      (p) =>
        `INSERT INTO "ModActivity" ("entityType", "entityId", activity) VALUES ('user', ${p}, 'chargeback:dp_1:banned')`,
    ],
  ];
  const cases = holds.flatMap(([name, sql]) =>
    [
      ['buyer', BUYER],
      ['seller', SELLER],
    ].map(([who, party]) => [`${name} on the ${who}`, sql(party as number)] as const)
  );

  it.each(holds)('%s on someone outside the deal keeps nothing', async (_name, sql) => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(sql(OTHER));
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
  });

  it.each(cases)('%s hides the deal files on schedule and keeps them', async (_name, sql) => {
    const { finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(sql);
    expect(await sweep()).toBe(2);
    expect(await removed(finalId)).toBe(true);
    expect(await removed(attachmentId)).toBe(true);
    expect(await purge()).toBe(0);
    expect(await kept(finalId)).toBe(true);
    expect(await kept(attachmentId)).toBe(true);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
  });

  it('an open report on another offering, or one being processed on this one, is told apart', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
        VALUES (${OTHER}, 'Other', 'desc', 500, 3, 1, 'Image', 'Active', 'Scanned', now());
      INSERT INTO "Report" (status, "createdAt") VALUES ('Pending', ${daysAgo(1)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (2, 1);`);
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);

    const other = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "Report" (status, "createdAt") VALUES ('Processing', ${daysAgo(45)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 2);`);
    await sweepAndPurge();
    expect(await kept(other.finalId)).toBe(true);
  });

  it('an open report on the offering keeps them; a handled one does not', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "Report" (status, "createdAt") VALUES ('Pending', ${daysAgo(45)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1);`);
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(true);
    await q(`UPDATE "Report" SET status = 'Unactioned', "statusSetAt" = ${daysAgo(35)}`);
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
  });

  it('a ban for another reason, or a handled report against them, keeps nothing', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      UPDATE "User" SET "bannedAt" = now(), meta = '{"banDetails": {"reasonCode": "Harassment", "detailsInternal": "spam"}}' WHERE id = ${SELLER};
      INSERT INTO "Report" (status, "createdAt", "statusSetAt") VALUES ('Actioned', ${daysAgo(
        50
      )}, ${daysAgo(45)});
      INSERT INTO "UserReport" ("userId", "reportId") VALUES (${BUYER}, 1);`);
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
  });

  it('a released evidence hold and a resolved appeal keep nothing', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${BUYER}, now());
      INSERT INTO "Appeal" ("userId", status) VALUES (${SELLER}, 'Rejected');`);
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
  });

  const partyViews = (dealId: number) =>
    Promise.all(
      [BUYER, SELLER].map((userId) =>
        files.listServiceDealFiles({ dealId, userId, isModerator: false, servableLevels: 31 })
      )
    );

  it("past its window, a party's view of a held deal matches an unheld one's", async () => {
    const unheld = await closedDeal('Cancelled', 40);
    await sweepAndPurge();
    const unheldViews = await partyViews(unheld.dealId);

    const held = await closedDeal('Cancelled', 40);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    await sweepAndPurge();
    expect(await kept(held.finalId)).toBe(true);
    expect(await partyViews(held.dealId)).toEqual(unheldViews);
    expect(unheldViews).toEqual([[], []]);
    for (const userId of [BUYER, SELLER])
      expect(
        await files.resolveServiceDealFileDownload({
          fileId: held.finalId,
          userId,
          isModerator: false,
        })
      ).toBeNull();
  });

  it('a held, hidden file stays listed and downloadable for a moderator outside the deal', async () => {
    const { dealId, finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${SELLER})`);
    await sweepAndPurge();
    const listed = await files.listServiceDealFiles({
      dealId,
      userId: OTHER,
      isModerator: true,
      canReviewCsam: true,
      servableLevels: 31,
    });
    expect(listed.map((f) => [f.id, f.canDownload, f.removedAt != null])).toEqual([
      [finalId, true, true],
      [attachmentId, true, true],
    ]);
    const download = await files.resolveServiceDealFileDownload({
      fileId: finalId,
      userId: OTHER,
      isModerator: true,
      canReviewCsam: true,
    });
    expect(download).toMatchObject({ key: `k/${dealId}/final`, removed: true });
  });
});

describe('the purge after the sweep', () => {
  it('deletes a removed upload that never finished, and keeps one that failed its scan', async () => {
    const { finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Uploading', "scanStatus" = 'Pending' WHERE id = $1`,
      [finalId]
    );
    // A content verdict leaves the status Ready; only a refusal at completion sets Failed.
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Ready', "scanStatus" = 'Failed' WHERE id = $1`,
      [attachmentId]
    );
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
    expect(await kept(attachmentId)).toBe(true);
  });

  it('deletes a removed file refused at completion, after settleFinals has marked its scan Failed', async () => {
    const { finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Failed', "failReason" = 'refused', "scanStatus" = 'Pending', "malwareScanStatus" = 'Pending'`
    );
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Failed' WHERE id = $1`, [
      attachmentId,
    ]);
    await unpack.settleFinals();
    const [settled] = await q<{ scanStatus: string }>(
      `SELECT "scanStatus" FROM "ServiceDealFile" WHERE id = $1`,
      [finalId]
    );
    expect(settled.scanStatus).toBe('Failed');
    await sweepAndPurge();
    expect(await kept(finalId)).toBe(false);
    expect(await kept(attachmentId)).toBe(true);
  });

  it('keeps a removed preview that was rejected', async () => {
    const { dealId } = await closedDeal('Cancelled', 40);
    const [preview] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "mimeType", size, status, "scanStatus", "malwareScanStatus")
       VALUES ($1, 'Preview', 'k/rejected', 'image/png', 10, 'Failed', 'Failed', 'Pending') RETURNING id`,
      [dealId]
    );
    await sweepAndPurge();
    expect(await kept(preview.id)).toBe(true);
  });

  it('deletes a removed preview its scan never reached', async () => {
    const { dealId } = await closedDeal('Cancelled', 40);
    const [preview] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "mimeType", size, status, "scanStatus", "malwareScanStatus")
       VALUES ($1, 'Preview', 'k/unscanned', 'image/png', 10, 'Processing', 'Pending', 'Pending') RETURNING id`,
      [dealId]
    );
    await sweepAndPurge();
    expect(await kept(preview.id)).toBe(false);
  });

  it('does not let a file whose delete keeps failing hold up the rest', async () => {
    const first = await closedDeal('Cancelled', 40);
    const second = await closedDeal('Cancelled', 40);
    s3.purgeObjectVersions.mockImplementation(async ({ key }: { key: string }) =>
      key.startsWith(`k/${first.dealId}/`)
        ? { versionsDeleted: 0, remaining: 1 }
        : { versionsDeleted: 1, remaining: 0 }
    );
    await sweep();
    await q(
      `UPDATE "ServiceDealFile" SET "removedAt" = "removedAt" - interval '10 minutes' WHERE "removedAt" IS NOT NULL`
    );
    for (let run = 0; run < 60 && (await kept(second.finalId)); run++)
      await files.purgeRemovedFiles({ limit: 1 });
    expect(await kept(second.finalId)).toBe(false);
    expect(await kept(first.finalId)).toBe(true);
  });

  it('waits until a download link signed before the removal has expired', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    expect(await files.purgeRemovedFiles()).toBe(0);
    expect(await kept(finalId)).toBe(true);
    expect(await purge()).toBe(2);
    expect(await kept(finalId)).toBe(false);
  });

  it('re-reads the holds under the row lock: one landing after the candidates were read stops the delete', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    // The candidate read ran before the hold landed.
    dbMock.dbWrite.$queryRaw.mockImplementationOnce((async () => [{ id: finalId }]) as never);
    expect(await purge()).toBe(0);
    expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
  });

  it('aborts, deleting nothing, when a hold cannot be read', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    await holder.db.exec(`ALTER TABLE "Appeal" RENAME TO "AppealGone"`);
    try {
      await expect(purge()).rejects.toThrow();
    } finally {
      await holder.db.exec(`ALTER TABLE "AppealGone" RENAME TO "Appeal"`);
    }
    expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
  });

  it('re-reads the holds before each delete: one landing after the claim stops it', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    // The storage HEAD runs after the claim and before the first delete.
    s3.send.mockImplementationOnce(async () => {
      await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${SELLER})`);
      return { ETag: '"abc123"' };
    });
    expect(await purge()).toBe(0);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
    expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
    expect(await q(`SELECT * FROM "ServiceDealFilePurge"`)).toEqual([]);
  });

  it('re-reads the holds before each object: one landing after the first stops the rest', async () => {
    const { finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await q(
      `UPDATE "ServiceDealFile" SET "deliveryKey" = 'k/archive', "watermarkedKey" = 'wm-1' WHERE id = $1`,
      [finalId]
    );
    // Only the final is a candidate, so the first object deleted is its archive.
    await q(`UPDATE "ServiceDealFile" SET "scanStatus" = 'Failed' WHERE id = $1`, [attachmentId]);
    await sweep();
    s3.purgeObjectVersions.mockImplementationOnce(async () => {
      await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
      return { versionsDeleted: 1, remaining: 0 };
    });
    expect(await purge()).toBe(0);
    expect(s3.purgeObjectVersions).toHaveBeenCalledOnce();
    expect(await kept(finalId)).toBe(true);
    // An object is gone, so the record stays, pending, beside the row.
    expect(await q(`SELECT "fileId" FROM "ServiceDealFilePurge"`)).toEqual([{ fileId: finalId }]);
  });

  it('deletes nothing when the record cannot be written', async () => {
    await closedDeal('Cancelled', 40);
    await sweep();
    await q(`ALTER TABLE "ServiceDealFilePurge" RENAME TO "ServiceDealFilePurgeGone"`);
    try {
      await expect(purge()).rejects.toThrow();
    } finally {
      await q(`ALTER TABLE "ServiceDealFilePurgeGone" RENAME TO "ServiceDealFilePurge"`);
    }
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
    expect(s3.deleteObject).not.toHaveBeenCalled();
    expect(await q(`SELECT id FROM "ServiceDealFile"`)).toHaveLength(2);
  });

  it("deletes a zip's archive and a published preview's copy as well", async () => {
    const { dealId, finalId } = await closedDeal('Cancelled', 40);
    await q(
      `UPDATE "ServiceDealFile" SET "deliveryKey" = 'k/archive', "watermarkedKey" = 'wm-1' WHERE id = $1`,
      [finalId]
    );
    await sweep();
    await purge();
    const keys = s3.purgeObjectVersions.mock.calls.map(([arg]) => [arg.bucket, arg.key]);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['bucket', `k/${dealId}/final`],
        ['bucket', 'k/archive'],
        ['image-store', 'wm-1'],
      ])
    );
  });

  it.each(['k/archive', 'wm-1'])(
    'keeps the row and leaves its record pending when only the delete of %s fails',
    async (failing) => {
      const { dealId, finalId } = await closedDeal('Cancelled', 40);
      await q(
        `UPDATE "ServiceDealFile" SET "deliveryKey" = 'k/archive', "watermarkedKey" = 'wm-1' WHERE id = $1`,
        [finalId]
      );
      s3.purgeObjectVersions.mockImplementation(async ({ key }: { key: string }) =>
        key === failing
          ? { versionsDeleted: 0, remaining: 1 }
          : { versionsDeleted: 1, remaining: 0 }
      );
      await sweepAndPurge();
      expect(await kept(finalId)).toBe(true);
      expect(
        await q(`SELECT "fileId" FROM "ServiceDealFilePurge" WHERE "fileId" = $1`, [finalId])
      ).toEqual([{ fileId: finalId }]);
      // The upload goes last, so a failure before it leaves the original in place.
      expect(s3.purgeObjectVersions.mock.calls.map(([arg]) => arg.key)).not.toContain(
        `k/${dealId}/final`
      );
    }
  );

  it('deletes every version of the objects and keeps a record with no name', async () => {
    const { dealId, finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    expect(await purge()).toBe(2);
    expect(await q(`SELECT id FROM "ServiceDealFile"`)).toEqual([]);
    expect(s3.purgeObjectVersions).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'bucket', key: `k/${dealId}/final` })
    );
    const [record] = await q(`SELECT * FROM "ServiceDealFilePurge" WHERE "fileId" = $1`, [finalId]);
    expect(record).toMatchObject({ fileId: finalId, dealId, size: 1234, etag: 'abc123' });
    expect(JSON.stringify(record)).not.toContain('portrait');
  });

  it('takes a store without versioning (501) as a plain delete, with no warning', async () => {
    const { dealId } = await closedDeal('Cancelled', 40);
    s3.purgeObjectVersions.mockRejectedValue(
      Object.assign(new Error('NotImplemented'), {
        name: 'NotImplemented',
        $metadata: { httpStatusCode: 501 },
      })
    );
    await sweep();
    expect(await purge()).toBe(2);
    expect(s3.deleteObject).toHaveBeenCalledWith('bucket', `k/${dealId}/final`, expect.anything());
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'object versions may remain after delete' })
    );
  });

  it('keeps the row and its pending record when the delete fails, and finishes it next run', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    const runs: [string, () => void][] = [
      [
        'a listing error other than 501',
        () => s3.purgeObjectVersions.mockRejectedValue(new Error('AccessDenied')),
      ],
      [
        'a 501 whose plain delete then fails',
        () => {
          s3.purgeObjectVersions.mockRejectedValue(
            Object.assign(new Error('NotImplemented'), { $metadata: { httpStatusCode: 501 } })
          );
          s3.deleteObject.mockRejectedValue(new Error('InternalError'));
        },
      ],
      [
        'versions still listed after the delete',
        () => s3.purgeObjectVersions.mockResolvedValue({ versionsDeleted: 1, remaining: 1 }),
      ],
    ];
    for (const [, setUp] of runs) {
      loggingMock.logToAxiom.mockClear();
      setUp();
      expect(await purge()).toBe(0);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
      expect(
        await q(`SELECT "fileId" FROM "ServiceDealFilePurge" WHERE "fileId" = $1`, [finalId])
      ).toEqual([{ fileId: finalId }]);
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'object versions may remain after delete' })
      );
    }
    s3.purgeObjectVersions.mockResolvedValue({ versionsDeleted: 1, remaining: 0 });
    s3.deleteObject.mockResolvedValue(undefined);
    expect(await purge()).toBe(2);
    expect(await kept(finalId)).toBe(false);
    expect(
      await q(`SELECT "fileId" FROM "ServiceDealFilePurge" WHERE "fileId" = $1`, [finalId])
    ).toEqual([{ fileId: finalId }]);
  });
});

describe('a party deleting a file', () => {
  const openDeal = async () => {
    const deal = await closedDeal('Cancelled', 1);
    await q(`UPDATE "ServiceDeal" SET status = 'Accepted', "closedAt" = NULL WHERE id = $1`, [
      deal.dealId,
    ]);
    return deal;
  };
  const deleteBoth = (deal: { finalId: number; attachmentId: number }) =>
    Promise.all([
      files.deleteServiceDealFile({ fileId: deal.finalId, userId: SELLER }),
      files.deleteServiceDealAttachment({ fileId: deal.attachmentId, userId: BUYER }),
    ]);

  it('hides the file at once and leaves the bytes to the purge, held or not', async () => {
    const unheld = await openDeal();
    expect(await deleteBoth(unheld)).toEqual([{ id: unheld.finalId }, { id: unheld.attachmentId }]);
    expect(await removed(unheld.finalId)).toBe(true);
    expect(await removed(unheld.attachmentId)).toBe(true);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
    expect(s3.deleteObject).not.toHaveBeenCalled();
    expect(await purge()).toBe(2);
    expect(await kept(unheld.finalId)).toBe(false);
    s3.purgeObjectVersions.mockClear();

    const held = await openDeal();
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    expect(await deleteBoth(held)).toEqual([{ id: held.finalId }, { id: held.attachmentId }]);
    expect(await removed(held.finalId)).toBe(true);
    expect(await removed(held.attachmentId)).toBe(true);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
    expect(s3.deleteObject).not.toHaveBeenCalled();
    expect(await purge()).toBe(0);
    expect(await kept(held.finalId)).toBe(true);
    expect(
      await q(`SELECT * FROM "ServiceDealFilePurge" WHERE "dealId" = $1`, [held.dealId])
    ).toEqual([]);
  });

  /** A published preview with its scan Image, on `dealId`. */
  const publishedPreview = async (dealId: number) => {
    await q(`INSERT INTO "Image" (id, url) VALUES (7${dealId}, 'scan-${dealId}')`);
    const [preview] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "mimeType", size, status, "scanStatus", "malwareScanStatus", "watermarkedKey", "imageId")
       VALUES ($1, 'Preview', $2, 'image/png', 10, 'Ready', 'Passed', 'Passed', $3, $4) RETURNING id`,
      [dealId, `k/${dealId}/preview`, `wm-${dealId}`, Number(`7${dealId}`)]
    );
    return preview.id;
  };
  const touchedKeys = () => s3.purgeObjectVersions.mock.calls.map(([arg]) => [arg.bucket, arg.key]);

  it('drops only the public copy of a held preview: the upload and its scan image stay', async () => {
    const { dealId } = await openDeal();
    const previewId = await publishedPreview(dealId);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${SELLER})`);
    expect(await files.deleteServiceDealFile({ fileId: previewId, userId: SELLER })).toEqual({
      id: previewId,
    });
    expect(touchedKeys()).toEqual([['image-store', `wm-${dealId}`]]);
    expect(s3.deleteObject).not.toHaveBeenCalled();
    const [row] = await q(
      `SELECT "s3Key", "watermarkedKey", "imageId" FROM "ServiceDealFile" WHERE id = $1`,
      [previewId]
    );
    expect(row).toEqual({
      s3Key: `k/${dealId}/preview`,
      watermarkedKey: null,
      imageId: Number(`7${dealId}`),
    });
    expect(await q(`SELECT id FROM "Image" WHERE id = $1`, [Number(`7${dealId}`)])).toHaveLength(1);
    await purge();
    expect(await kept(previewId)).toBe(true);
    expect(touchedKeys()).toEqual([['image-store', `wm-${dealId}`]]);
  });

  it('drops the public copy of a preview the sweep hides on a held deal, and nothing else', async () => {
    const { dealId } = await closedDeal('Cancelled', 40);
    const previewId = await publishedPreview(dealId);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    await sweep();
    expect(await files.dropRemovedPreviewCopies()).toBe(1);
    expect(await purge()).toBe(0);
    expect(touchedKeys()).toEqual([['image-store', `wm-${dealId}`]]);
    expect(await kept(previewId)).toBe(true);
    expect(await q(`SELECT id FROM "Image" WHERE id = $1`, [Number(`7${dealId}`)])).toHaveLength(1);
  });
});

describe('account deletion', () => {
  it("removes the user's own uploads on closed deals at once, not the other party's", async () => {
    const { finalId, attachmentId } = await closedDeal('Completed', 1);
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(finalId)).toBe(true);
    expect(await removed(attachmentId)).toBe(false);
  });

  it("for the buyer, removes their attachments and leaves the seller's final and preview", async () => {
    const { dealId, finalId, attachmentId } = await closedDeal('Completed', 1);
    const [preview] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "mimeType", size, status, "scanStatus", "malwareScanStatus")
       VALUES ($1, 'Preview', $2, 'image/png', 10, 'Ready', 'Passed', 'Passed') RETURNING id`,
      [dealId, `k/${dealId}/preview`]
    );
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(BUYER));
    expect(await removed(attachmentId)).toBe(true);
    expect(await removed(finalId)).toBe(false);
    expect(await removed(preview.id)).toBe(false);
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(preview.id)).toBe(true);
  });

  it('hides them under a hold but the purge keeps them; an open deal keeps them unhidden', async () => {
    const held = await closedDeal('Completed', 1);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(held.finalId)).toBe(true);
    expect(await purge()).toBe(0);
    expect(await kept(held.finalId)).toBe(true);
    await q(`UPDATE "ServiceDealFile" SET "removedAt" = NULL`);
    await q(`DELETE FROM "EvidenceHold"`);
    await q(
      `UPDATE "ServiceDeal" SET status = 'Delivered', "releaseAt" = NULL, "settledAt" = NULL`
    );
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(held.finalId)).toBe(false);
  });
});
