import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
void loggingMock;

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
});

beforeEach(async () => {
  vi.clearAllMocks();
  s3.purgeObjectVersions.mockResolvedValue({ versionsDeleted: 2, remaining: 0 });
  s3.deleteObject.mockResolvedValue(undefined);
  s3.send.mockResolvedValue({ ETag: '"abc123"' });
  await holder.db.exec(`
    TRUNCATE "ServiceDealFilePurge", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering",
      "Report", "UserReport", "CsamReport", "EvidenceHold", "Appeal", "ModActivity" RESTART IDENTITY CASCADE;
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
    const unsettled = await closedDeal('Cancelled', 60, false);
    expect(unsettled.dealId).toBeGreaterThan(0);
    const open = await closedDeal('Cancelled', 60);
    await q(`UPDATE "ServiceDeal" SET status = 'Accepted' WHERE id = $1`, [open.dealId]);
    expect(await sweep()).toBe(0);
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

  it('defaults to the date the notice ships', async () => {
    const { SERVICE_DEAL_FILE_RETENTION_EFFECTIVE_AT } = await import(
      '~/shared/constants/creator-services.constants'
    );
    const { finalId } = await closedDeal('Cancelled', 400);
    await retention.markExpiredDealFiles();
    expect(await removed(finalId)).toBe(
      SERVICE_DEAL_FILE_RETENTION_EFFECTIVE_AT.getTime() + 30 * 86_400_000 <= Date.now()
    );
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
    [
      'a report handled',
      `INSERT INTO "Report" (status, "createdAt", "statusSetAt") VALUES ('Actioned', ${daysAgo(
        50
      )}, ${daysAgo(10)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1)`,
    ],
  ])('%s', async (_name, sql) => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(sql);
    await sweep();
    expect(await removed(finalId)).toBe(false);
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
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });

  it.each(cases)('%s keeps the deal files', async (_name, sql) => {
    const { finalId, attachmentId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(sql);
    expect(await sweep()).toBe(0);
    expect(await removed(finalId)).toBe(false);
    expect(await removed(attachmentId)).toBe(false);
  });

  it('an open report on another offering, or one being processed on this one, is told apart', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
        VALUES (${OTHER}, 'Other', 'desc', 500, 3, 1, 'Image', 'Active', 'Scanned', now());
      INSERT INTO "Report" (status, "createdAt") VALUES ('Pending', ${daysAgo(1)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (2, 1);`);
    await sweep();
    expect(await removed(finalId)).toBe(true);

    const other = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "Report" (status, "createdAt") VALUES ('Processing', ${daysAgo(45)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 2);`);
    await sweep();
    expect(await removed(other.finalId)).toBe(false);
  });

  it('an open report on the offering keeps them; a handled one does not', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "Report" (status, "createdAt") VALUES ('Pending', ${daysAgo(45)});
      INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, 1);`);
    await sweep();
    expect(await removed(finalId)).toBe(false);
    await q(`UPDATE "Report" SET status = 'Unactioned', "statusSetAt" = ${daysAgo(35)}`);
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });

  it('a ban for another reason, or a handled report against them, keeps nothing', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      UPDATE "User" SET "bannedAt" = now(), meta = '{"banDetails": {"reasonCode": "Harassment", "detailsInternal": "spam"}}' WHERE id = ${SELLER};
      INSERT INTO "Report" (status, "createdAt", "statusSetAt") VALUES ('Actioned', ${daysAgo(
        50
      )}, ${daysAgo(45)});
      INSERT INTO "UserReport" ("userId", "reportId") VALUES (${BUYER}, 1);`);
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });

  it('a released evidence hold and a resolved appeal keep nothing', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await holder.db.exec(`
      INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${BUYER}, now());
      INSERT INTO "Appeal" ("userId", status) VALUES (${SELLER}, 'Rejected');`);
    await sweep();
    expect(await removed(finalId)).toBe(true);
  });
});

describe('the purge after the sweep', () => {
  it('checks the holds again: one placed after marking stops the delete', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    expect(await files.purgeRemovedFiles()).toBe(0);
    expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
  });

  it('fails closed: a hold that cannot be read deletes nothing', async () => {
    const { finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    await holder.db.exec(`ALTER TABLE "Appeal" RENAME TO "AppealGone"`);
    try {
      await expect(files.purgeRemovedFiles()).rejects.toThrow();
    } finally {
      await holder.db.exec(`ALTER TABLE "AppealGone" RENAME TO "Appeal"`);
    }
    expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [finalId])).toHaveLength(1);
    expect(s3.purgeObjectVersions).not.toHaveBeenCalled();
  });

  it("deletes a zip's archive and a published preview's copy as well", async () => {
    const { dealId, finalId } = await closedDeal('Cancelled', 40);
    await q(
      `UPDATE "ServiceDealFile" SET "deliveryKey" = 'k/archive', "watermarkedKey" = 'wm-1' WHERE id = $1`,
      [finalId]
    );
    await sweep();
    await files.purgeRemovedFiles();
    const keys = s3.purgeObjectVersions.mock.calls.map(([arg]) => [arg.bucket, arg.key]);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['bucket', `k/${dealId}/final`],
        ['bucket', 'k/archive'],
        ['image-store', 'wm-1'],
      ])
    );
  });

  it('deletes every version of the objects and keeps a record with no name', async () => {
    const { dealId, finalId } = await closedDeal('Cancelled', 40);
    await sweep();
    expect(await files.purgeRemovedFiles()).toBe(2);
    expect(await q(`SELECT id FROM "ServiceDealFile"`)).toEqual([]);
    expect(s3.purgeObjectVersions).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'bucket', key: `k/${dealId}/final` })
    );
    const [record] = await q(`SELECT * FROM "ServiceDealFilePurge" WHERE "fileId" = $1`, [finalId]);
    expect(record).toMatchObject({ fileId: finalId, dealId, size: 1234, etag: 'abc123' });
    expect(JSON.stringify(record)).not.toContain('portrait');
  });

  it('falls back to a plain delete where versions cannot be listed, and still purges', async () => {
    const { dealId } = await closedDeal('Cancelled', 40);
    s3.purgeObjectVersions.mockRejectedValue(new Error('AccessDenied'));
    await sweep();
    expect(await files.purgeRemovedFiles()).toBe(2);
    expect(s3.deleteObject).toHaveBeenCalledWith('bucket', `k/${dealId}/final`, expect.anything());
    expect(await q(`SELECT id FROM "ServiceDealFile"`)).toEqual([]);
  });
});

describe('account deletion', () => {
  it("removes the user's own uploads on closed deals at once, not the other party's", async () => {
    const { finalId, attachmentId } = await closedDeal('Completed', 1);
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(finalId)).toBe(true);
    expect(await removed(attachmentId)).toBe(false);
  });

  it('keeps them under a hold, and while the deal is open', async () => {
    const held = await closedDeal('Completed', 1);
    await q(`INSERT INTO "EvidenceHold" ("userId") VALUES (${BUYER})`);
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(held.finalId)).toBe(false);
    await q(`DELETE FROM "EvidenceHold"`);
    await q(
      `UPDATE "ServiceDeal" SET status = 'Delivered', "releaseAt" = NULL, "settledAt" = NULL`
    );
    await dbMock.dbWrite.$executeRaw(retention.markUserDealUploadsRemovedSql(SELLER));
    expect(await removed(held.finalId)).toBe(false);
  });
});
