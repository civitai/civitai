import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ChatService from '~/server/services/chat.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as CreatorShop from '~/server/services/creator-shop.service';
import type * as ZipModule from '~/server/utils/service-deal-zip';
import type * as ScanModule from '~/server/services/creator-service-deal-file-scan';
import { buildZip, JPEG_BYTES, PNG_BYTES } from '~/server/utils/__tests__/zip-fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A buyer's Attachment: it goes through the Final scan pipeline, reaches the seller only once it
 * passes, and plays no part in delivery, acceptance or payout. Run against the real migrations on an
 * in-process Postgres with the same fakes as the unpack suite (storage, the image service, the
 * scan-copy builder, Buzz and chat).
 */

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const buzz = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn(),
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getTransactionByExternalId: vi.fn(),
  refundTransaction: vi.fn(),
}));
// The deal flows notify buyer and seller; accept the call without asserting on it.
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
}));
const chat = vi.hoisted(() => ({ upsertDealChat: vi.fn(), createMessage: vi.fn() }));
vi.mock('~/server/services/chat.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatService>()),
  ...chat,
}));
const shop = vi.hoisted(() => ({ assertCreatorShopVisible: vi.fn() }));
vi.mock('~/server/services/creator-shop.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorShop>()),
  ...shop,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));

const s3 = vi.hoisted(() => ({
  getPutUrl: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
  getGetUrlByKey: vi.fn(),
  uploadImageBufferToStore: vi.fn(),
  send: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({
  getBucket: async () => 'bucket',
  getS3Client: () => ({ send: s3.send }),
  getPutUrl: s3.getPutUrl,
  headObject: s3.headObject,
  deleteObject: s3.deleteObject,
  getGetUrlByKey: s3.getGetUrlByKey,
  uploadImageBufferToStore: s3.uploadImageBufferToStore,
}));
vi.mock('@civitai/storage/s3-purge-versions', () => ({
  purgeObjectVersions: async ({ bucket, key }: { bucket: string; key: string }) => {
    await s3.deleteObject(bucket, key);
    return { versionsDeleted: 1, remaining: 0 };
  },
}));

/** The bucket's contents, by key; the zip reader is pointed at it. */
const bucket = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  zipReads: [] as string[],
}));
vi.mock('~/server/utils/service-deal-zip', async (importOriginal) => {
  const original = await importOriginal<typeof ZipModule>();
  return {
    ...original,
    s3ZipSource: (_client: unknown, _bucket: string, key: string) => {
      bucket.zipReads.push(key);
      return original.bufferZipSource(bucket.objects.get(key)!);
    },
  };
});

const images = vi.hoisted(() => ({ createImage: vi.fn(), deleteImages: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  createImage: images.createImage,
  deleteImages: images.deleteImages,
}));

const preview = vi.hoisted(() => ({ entryCopy: vi.fn() }));
vi.mock('~/server/utils/service-deal-preview', () => ({
  buildWatermarkedPreview: vi.fn(),
  buildScanCopy: vi.fn(),
  buildEntryScanCopy: preview.entryCopy,
  PreviewRejectedError: class PreviewRejectedError extends Error {},
}));

/** The malware-scan flag, and which Finals reached the (real, stub) scan. */
const malwareScan = vi.hoisted(() => ({
  on: vi.fn(),
  submitted: [] as number[],
  refuse: new Set<number>(),
}));
vi.mock('~/server/services/creator-service-deal-file-scan', async (importOriginal) => {
  const original = await importOriginal<typeof ScanModule>();
  return {
    ...original,
    isFinalsMalwareScanOn: malwareScan.on,
    submitFinalScan: (file: ScanModule.FinalScanTarget) => {
      if (malwareScan.refuse.has(file.id)) throw new Error('scanner down');
      malwareScan.submitted.push(file.id);
      return original.submitFinalScan(file);
    },
  };
});

type Raw = ReturnType<typeof pgliteRaw>;
const bridge = (db: { query: PGlite['query'] }) => {
  const raw = pgliteRaw(db as PGlite);
  return { $executeRaw: raw.executeRaw, $queryRaw: raw.queryRaw };
};
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbRead.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);
dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
  holder.db.transaction((tx) => fn(bridge(tx)))) as never);

const files = await import('~/server/services/creator-service-deal-file.service');
const reviewImages = await import('~/server/services/creator-service-deal-review-images');
const reviewDisplay = await import('~/server/services/creator-service-review-display.service');
const deals = await import('~/server/services/creator-service-deal.service');
const unpack = await import('~/server/services/creator-service-deal-unpack.service');
const reviews = await import('~/server/services/creator-service-dispute-review.service');
const { dealFinalsClear } = await import('~/server/services/creator-service-escrow.service');
const { dealReadyToDeliver } = await import('~/server/services/creator-service-deal-file-sql');
const { requestServiceDealAttachmentSchema } = await import(
  '~/server/schema/creator-service-deal.schema'
);
const { SERVICE_ATTACHMENT_MAX_FILES } = await import(
  '~/shared/constants/creator-services.constants'
);

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
  '20271119070000_service_deal_file_scanned_etag',
  '20271120100000_service_deal_reviewed_happy',
  '20271120100100_service_deal_reviews',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const SELLER = 1;
const BUYER = 2;
const STRANGER = 3;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

type FileRecord = {
  id: number;
  status: string;
  scanStatus: string;
  failReason: string | null;
  s3Key: string;
  unpackedAt: Date | null;
  processingAt: Date | null;
  malwareScanStatus: string;
  repackedAt: Date | null;
  deliveryKey: string | null;
  deliverySize: number | null;
  removedAt: Date | null;
};
type EntryRecord = {
  id: number;
  fileId: number;
  entryIndex: number;
  path: string;
  size: number;
  imageId: number | null;
  scanKey: string | null;
  nsfwLevel: number | null;
  scanStatus: string;
  failReason: string | null;
};

const fileRow = async (id: number) =>
  (await q<FileRecord>(`SELECT * FROM "ServiceDealFile" WHERE id = $1`, [id]))[0];
const entries = (fileId: number) =>
  q<EntryRecord>(`SELECT * FROM "ServiceDealFileEntry" WHERE "fileId" = $1 ORDER BY "entryIndex"`, [
    fileId,
  ]);
const dealStatus = async (id: number) =>
  (
    await q<{ status: string; disputeReason: string | null }>(
      `SELECT status::text, "disputeReason" FROM "ServiceDeal" WHERE id = $1`,
      [id]
    )
  )[0];

const charged = { transactionIds: [], totalAmount: 500, transactionCount: 1 };
const body = (bytes: Buffer) => ({ Body: { transformToByteArray: async () => bytes } });

async function accepted() {
  await q(`UPDATE "ServiceOffering" SET "previewKind" = 'None'::"ServicePreviewKind"`);
  buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged);
  const { id } = await deals.requestServiceDeal({
    offeringId: 1,
    expectedPrice: 500,
    expectedRevisionsIncluded: 1,
    expectedDeliveryDays: 3,
    buyerId: BUYER,
    requestText: 'please',
    disclosureVersion: SERVICES_TERMS_VERSION,
    buzzType: 'yellow',
    servableLevels: 31,
    consentLevels: 1,
  });
  await deals.acceptServiceDeal({ dealId: id, userId: SELLER });
  return id;
}

/**
 * Uploads a Final the way a seller does, so it is Ready at the server-held key, and puts `content`
 * in the bucket at THAT key (and nowhere else: the seller's own upload key holds nothing).
 */
async function final(dealId: number, fileName: string, content: Buffer) {
  const { fileId } = await files.requestServiceDealUpload({
    dealId,
    userId: SELLER,
    kind: 'Final',
    fileName,
    mimeType: 'application/octet-stream',
    size: content.byteLength,
  });
  s3.headObject.mockResolvedValue({ status: 'present', size: content.byteLength });
  s3.send.mockResolvedValue(body(content.subarray(0, 64)));
  await files.completeServiceDealUpload({ fileId, userId: SELLER });
  const row = await fileRow(fileId);
  expect(row.status).toBe('Ready');
  expect(row.s3Key).toMatch(/^service-deals\/files\//);
  bucket.objects.set(row.s3Key, content);
  return fileId;
}

const IMAGE_A = PNG_BYTES(100);
const IMAGE_B = JPEG_BYTES(200);
const SCAN_COPY = (n: number) => Buffer.from(`scan-copy-${n}`);

/** Marks every Image as scanned with a verdict. */
const verdict = (ingestion: string, extra = '', level = 1) =>
  q(`UPDATE "Image" SET ingestion = $1::"ImageIngestionStatus", "nsfwLevel" = ${level}${extra}`, [
    ingestion,
  ]);

const settle = async () => {
  await unpack.settleEntryScans();
  return unpack.settleFinals();
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false, meta jsonb);
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
    CREATE TABLE "Appeal" (id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL);
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text NOT NULL);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 1,
      "tosViolation" boolean NOT NULL DEFAULT false);
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
  await holder.db.exec(`
    ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "userId" int, ADD COLUMN IF NOT EXISTS "blockedFor" text;
    ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]';`);
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const fn of [...Object.values(buzz), ...Object.values(s3), preview.entryCopy])
    fn.mockReset();
  bucket.objects.clear();
  bucket.zipReads.length = 0;
  malwareScan.on.mockResolvedValue(true);
  // No orchestrator unless a test names one: a local .env may carry a real token.
  setEnv({ ORCHESTRATOR_ACCESS_TOKEN: '' });
  malwareScan.submitted.length = 0;
  malwareScan.refuse.clear();
  s3.getPutUrl.mockImplementation(async (key: string) => ({ url: `https://put/${key}` }));
  s3.deleteObject.mockResolvedValue(undefined);
  chat.upsertDealChat.mockResolvedValue({ id: 77 });
  chat.createMessage.mockResolvedValue({});
  shop.assertCreatorShopVisible.mockResolvedValue([]);
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
  let copies = 0;
  preview.entryCopy.mockImplementation(async () => ({
    data: SCAN_COPY(++copies),
    mimeType: 'image/webp',
    width: 800,
    height: 600,
    frames: 1,
  }));
  let keys = 0;
  s3.uploadImageBufferToStore.mockImplementation(async () => ({ key: `scan-key-${++keys}` }));
  images.createImage.mockImplementation(async ({ url }: { url: string }) => {
    const [row] = await q<{ id: number }>(`INSERT INTO "Image" (url) VALUES ($1) RETURNING id`, [
      url,
    ]);
    return { id: row.id };
  });
  images.deleteImages.mockImplementation(async (ids: number[]) => {
    await q(`DELETE FROM "Image" WHERE id = ANY($1::int[])`, [ids]);
  });
  await holder.db.exec(`
    TRUNCATE "ServiceDealReviewImage", "ServiceDealReview", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image", "CsamReport", "ServiceDisputeReview" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'None', 'Active', 'Scanned', now());
  `);
});

/** Uploads an Attachment the way a buyer does, Ready at the server-held key with `content` there. */
const ATTESTED = { rightsAttested: true, likenessAttested: true } as const;

async function attach(dealId: number, fileName: string, content: Buffer, userId = BUYER) {
  const { fileId } = await files.requestServiceDealAttachment({
    ...ATTESTED,
    dealId,
    userId,
    fileName,
    mimeType: 'application/octet-stream',
    size: content.byteLength,
  });
  s3.headObject.mockResolvedValue({ status: 'present', size: content.byteLength });
  s3.send.mockResolvedValue(body(content.subarray(0, 64)));
  await files.completeServiceDealAttachment({ fileId, userId });
  const row = await fileRow(fileId);
  expect(row.status).toBe('Ready');
  bucket.objects.set(row.s3Key, content);
  return fileId;
}

const TEXT = Buffer.from('plain text here, a caption file');

/** Runs the pipeline over every waiting file and records a clean malware verdict on `fileIds`. */
async function scanned(fileIds: number[], { malware = 'Passed' } = {}) {
  while ((await unpack.unpackFinals()) > 0);
  for (const id of fileIds)
    await q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = $2::"ServiceDealFileScanStatus", "repackedAt" = COALESCE("repackedAt", now()) WHERE id = $1`,
      [id, malware]
    );
  return settle();
}

/** A delivered round: one Final that passed every scan. */
async function delivered(dealId: number) {
  const finalId = await final(dealId, 'result.txt', TEXT);
  await scanned([finalId]);
  expect((await fileRow(finalId)).scanStatus).toBe('Passed');
  await files.deliverServiceDeal({ dealId, userId: SELLER });
  return finalId;
}

/** A moderator here holds the csamReports permission unless `canReviewCsam` says otherwise. */
const list = (dealId: number, userId: number, isModerator = false, canReviewCsam = isModerator) =>
  files.listServiceDealFiles({ dealId, userId, isModerator, canReviewCsam, servableLevels: 31 });
const download = (
  fileId: number,
  userId: number,
  isModerator = false,
  canReviewCsam = isModerator
) =>
  files.resolveServiceDealFileDownload({
    servableLevels: 31,
    fileId,
    userId,
    isModerator,
    canReviewCsam,
  });

const finalsClear = async (dealId: number) =>
  (
    (await dbMock.dbWrite.$queryRaw`
      SELECT ${dealFinalsClear()} AS "ok" FROM "ServiceDeal" WHERE "id" = ${dealId}::int`) as {
      ok: boolean;
    }[]
  )[0].ok;
const readyToDeliver = async (dealId: number) =>
  (
    (await dbMock.dbWrite.$queryRaw`
      SELECT ${dealReadyToDeliver()} AS "ok" FROM "ServiceDeal" WHERE "id" = ${dealId}::int`) as {
      ok: boolean;
    }[]
  )[0].ok;

/** The purge, once the download-link lifetime it waits out has passed. */
const agedPurge = async () => {
  await holder.db.query(
    `UPDATE "ServiceDealFile" SET "removedAt" = "removedAt" - interval '10 minutes' WHERE "removedAt" IS NOT NULL`
  );
  return files.purgeRemovedFiles();
};

describe('attaching', () => {
  it.each(['a.mp4', 'a.webm'])(
    'refuses a video attachment (%s) on the server',
    async (fileName) => {
      const dealId = await accepted();
      await expect(
        files.requestServiceDealAttachment({
          ...ATTESTED,
          dealId,
          userId: BUYER,
          fileName,
          mimeType: 'video/mp4',
          size: 10,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toEqual([]);
    }
  );

  it('records the attestation time and stores the upload at a server-held key', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    const [row] = await q<{ kind: string; attestedAt: Date | null; s3Key: string }>(
      `SELECT kind::text, "attestedAt", "s3Key" FROM "ServiceDealFile" WHERE id = $1`,
      [fileId]
    );
    expect(row.kind).toBe('Attachment');
    expect(row.attestedAt).toBeInstanceOf(Date);
    expect(row.s3Key).toMatch(/^service-deals\/files\/\d+\/\d+\/attachment\//);
  });

  it('refuses input without both attestations', () => {
    const base = { dealId: 1, fileName: 'a.zip', mimeType: 'application/zip', size: 10 };
    expect(
      requestServiceDealAttachmentSchema.safeParse({
        ...base,
        rightsAttested: true,
        likenessAttested: true,
      }).success
    ).toBe(true);
    for (const missing of [
      { rightsAttested: true },
      { likenessAttested: true },
      { rightsAttested: false, likenessAttested: true },
      { rightsAttested: true, likenessAttested: false },
    ])
      expect(requestServiceDealAttachmentSchema.safeParse({ ...base, ...missing }).success).toBe(
        false
      );
  });

  it('is open from the request until the seller delivers, and closed after', async () => {
    await q(`UPDATE "ServiceOffering" SET "previewKind" = 'None'::"ServicePreviewKind"`);
    buzz.createMultiAccountBuzzTransaction.mockResolvedValue(charged);
    const { id: dealId } = await deals.requestServiceDeal({
      offeringId: 1,
      expectedPrice: 500,
      expectedRevisionsIncluded: 1,
      expectedDeliveryDays: 3,
      buyerId: BUYER,
      requestText: 'please',
      disclosureVersion: SERVICES_TERMS_VERSION,
      buzzType: 'yellow',
      servableLevels: 31,
      consentLevels: 1,
    });
    // Requested: not yet accepted, and the buyer can attach.
    await attach(dealId, 'notes.txt', TEXT);
    await deals.acceptServiceDeal({ dealId, userId: SELLER });
    // An upload started before delivery cannot be completed after it.
    const { fileId: late } = await files.requestServiceDealAttachment({
      ...ATTESTED,
      dealId,
      userId: BUYER,
      fileName: 'late.txt',
      mimeType: 'text/plain',
      size: TEXT.byteLength,
    });
    await delivered(dealId);
    expect((await dealStatus(dealId)).status).toBe('Delivered');

    await expect(
      files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: 'more.txt',
        mimeType: 'text/plain',
        size: 10,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    s3.headObject.mockResolvedValue({ status: 'present', size: TEXT.byteLength });
    await expect(
      files.completeServiceDealAttachment({ fileId: late, userId: BUYER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      files.deleteServiceDealAttachment({ fileId: late, userId: BUYER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is for the buyer alone: the seller cannot attach, complete or remove one', async () => {
    const dealId = await accepted();
    await expect(
      files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: SELLER,
        fileName: 'a.txt',
        mimeType: 'text/plain',
        size: 10,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { fileId } = await files.requestServiceDealAttachment({
      ...ATTESTED,
      dealId,
      userId: BUYER,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      size: TEXT.byteLength,
    });
    s3.headObject.mockResolvedValue({ status: 'present', size: TEXT.byteLength });
    // Through the seller's own endpoints, the buyer's file does not exist.
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      { code: 'NOT_FOUND' }
    );
    await expect(files.deleteServiceDealFile({ fileId, userId: SELLER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await fileRow(fileId)).status).toBe('Uploading');
  });

  it('counts the limit across the deal, not per round', async () => {
    const dealId = await accepted();
    for (let i = 0; i < SERVICE_ATTACHMENT_MAX_FILES; i++)
      await files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: `f${i}.txt`,
        mimeType: 'text/plain',
        size: 10,
      });
    await q(`UPDATE "ServiceDeal" SET "revisionsUsed" = 1`);
    await expect(
      files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: 'one-more.txt',
        mimeType: 'text/plain',
        size: 10,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('the scan an attachment goes through', () => {
  it("is the Finals' pipeline: images become scan copies owned by the buyer", async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([
        { name: 'one.png', data: IMAGE_A },
        { name: 'two.jpg', data: IMAGE_B },
      ])
    );
    expect(await unpack.unpackFinals()).toBe(1);
    expect(images.createImage).toHaveBeenCalledTimes(2);
    for (const [created] of images.createImage.mock.calls)
      expect(created).toMatchObject({ userId: BUYER, type: 'image' });
    expect((await entries(fileId)).map((e) => e.scanStatus)).toEqual(['Pending', 'Pending']);
  });

  it('passes only when every image and the malware scan passed', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();
    await verdict('Scanned');
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now()`);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
  });

  it("rejects an image rated above the deal's level: the buyer is told, the seller never sees it", async () => {
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 2`);
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();
    await verdict('Scanned', '', 4);
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now()`);
    expect(await settle()).toEqual({ finalsFailed: 1, finalsPassed: 0 });

    const [mine] = await list(dealId, BUYER);
    expect(mine).toMatchObject({ id: fileId, kind: 'Attachment', scanStatus: 'Failed' });
    expect(mine.failReason).toBe('A file in this delivery was rejected when it was checked.');
    expect(await list(dealId, SELLER)).toEqual([]);
    expect(await download(fileId, SELLER)).toBeNull();
  });

  it("passes an image rated exactly at the deal's level", async () => {
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 4`);
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();
    await verdict('Scanned', '', 4);
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now()`);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
  });

  it('is refused while the malware scan is off', async () => {
    const dealId = await accepted();
    malwareScan.on.mockResolvedValue(false);
    await expect(
      files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        size: TEXT.byteLength,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await q(`SELECT id FROM "ServiceDealFile"`)).toEqual([]);
  });

  it('never passes on a skipped malware scan, though a Final does while the scan is off', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    malwareScan.on.mockResolvedValue(false);
    const finalId = await final(dealId, 'result.txt', TEXT);
    while ((await unpack.unpackFinals()) > 0);
    await q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'NotScanned', "repackedAt" = now()`
    );
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    expect((await fileRow(finalId)).scanStatus).toBe('Passed');
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
    // Nor when a verdict is recorded for it directly.
    expect(await files.recordFinalScanResult({ fileId, verdict: 'Passed' })).toMatchObject({
      recorded: false,
    });
    expect(await list(dealId, SELLER)).toEqual([expect.objectContaining({ id: finalId })]);
    expect(await download(fileId, SELLER)).toBeNull();
  });

  it('does not let attachments waiting on a skipped scan crowd out a Final that can pass', async () => {
    malwareScan.on.mockResolvedValue(false);
    const dealId = await accepted();
    // More waiting attachments than one settle pass reads, all ahead of the Final.
    await q(
      `INSERT INTO "ServiceDealFile" ("dealId", kind, "s3Key", "fileName", "mimeType", size, status,
         "unpackedAt", "repackedAt", "malwareScanStatus")
       SELECT $1, 'Attachment', 'k-' || n, 'a.txt', 'text/plain', 1, 'Ready', now(), now(), 'NotScanned'
       FROM generate_series(1, $2::int) n`,
      [dealId, unpack.SETTLE_BATCH + 10]
    );
    const finalId = await final(dealId, 'result.txt', TEXT);
    while ((await unpack.unpackFinals()) > 0);
    await q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'NotScanned', "repackedAt" = now() WHERE id = $1`,
      [finalId]
    );
    await settle();
    expect((await fileRow(finalId)).scanStatus).toBe('Passed');
  });

  it('holds nothing when it fails, even on a delivered deal', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await delivered(dealId);
    await scanned([fileId], { malware: 'Failed' });
    expect((await fileRow(fileId)).scanStatus).toBe('Failed');
    expect((await dealStatus(dealId)).status).toBe('Delivered');
  });
});

/** The file's row if it was kept on removal. */
const keptRows = (fileId: number) =>
  q<{ s3Key: string; status: string }>(
    `SELECT "s3Key", status::text FROM "ServiceDealFile" WHERE id = $1 AND "removedAt" IS NOT NULL`,
    [fileId]
  );
const deletedKeys = () => s3.deleteObject.mock.calls.map((call) => call[1]);
/** The source keys of every CopyObject the bucket was sent with `key` as its destination. */
const copiesTo = (key: string) =>
  s3.send.mock.calls
    .map(([command]) => (command as { input?: { Key?: string; CopySource?: string } }).input)
    .filter((input) => input?.Key === key && input.CopySource)
    .map((input) => decodeURI(input!.CopySource!).replace(/^bucket\//, ''));

/** A zip whose one image was rated above the deal's level. */
async function rejectedZip(dealId: number, upload: typeof attach) {
  await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 2`);
  const fileId = await upload(dealId, 'dataset.zip', buildZip([{ name: 'a.png', data: IMAGE_A }]));
  await unpack.unpackFinals();
  await verdict('Scanned', '', 4);
  await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now()`);
  await settle();
  expect((await fileRow(fileId)).scanStatus).toBe('Failed');
  return fileId;
}

const ALL_STATUSES = [
  'Requested',
  'Accepted',
  'Delivered',
  'InRevision',
  'Completed',
  'Declined',
  'Expired',
  'CancellationRequested',
  'Cancelled',
  'Disputed',
] as const;
const ATTACHABLE = ['Requested', 'Accepted', 'InRevision'];
const setStatus = (dealId: number, status: string) =>
  q(
    `UPDATE "ServiceDeal" SET status = $2::"ServiceDealStatus",
       "releaseAt" = CASE WHEN $2 = 'Completed' THEN now() ELSE "releaseAt" END
     WHERE id = $1`,
    [dealId, status]
  );
const requestAs = (dealId: number, userId: number) =>
  files.requestServiceDealAttachment({
    ...ATTESTED,
    dealId,
    userId,
    fileName: 'a.txt',
    mimeType: 'text/plain',
    size: TEXT.byteLength,
  });

describe('who may attach, and when', () => {
  it.each(ALL_STATUSES)('a deal that is %s', async (status) => {
    const dealId = await accepted();
    const existing = await attach(dealId, 'notes.txt', TEXT);
    await setStatus(dealId, status);
    if (ATTACHABLE.includes(status)) {
      await expect(requestAs(dealId, BUYER)).resolves.toMatchObject({ fileId: expect.any(Number) });
      await files.deleteServiceDealAttachment({ fileId: existing, userId: BUYER });
      expect((await fileRow(existing)).removedAt).not.toBeNull();
    } else {
      await expect(requestAs(dealId, BUYER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        files.deleteServiceDealAttachment({ fileId: existing, userId: BUYER })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await fileRow(existing)).status).toBe('Ready');
    }
  });

  it.each([
    ['the seller', SELLER],
    ['a third user', STRANGER],
  ])("refuses %s the buyer's attachment", async (_, userId) => {
    const dealId = await accepted();
    const { fileId } = await requestAs(dealId, BUYER);
    const ready = await attach(dealId, 'notes.txt', TEXT);
    s3.headObject.mockResolvedValue({ status: 'present', size: TEXT.byteLength });
    await expect(files.completeServiceDealAttachment({ fileId, userId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      files.deleteServiceDealAttachment({ fileId: ready, userId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await fileRow(fileId)).status).toBe('Uploading');
    expect((await fileRow(ready)).status).toBe('Ready');
  });

  it("refuses the buyer the seller's Finals through the attachment endpoints", async () => {
    const dealId = await accepted();
    const { fileId: uploading } = await files.requestServiceDealUpload({
      dealId,
      userId: SELLER,
      kind: 'Final',
      fileName: 'result.txt',
      mimeType: 'text/plain',
      size: TEXT.byteLength,
    });
    const ready = await final(dealId, 'other.txt', TEXT);
    s3.headObject.mockResolvedValue({ status: 'present', size: TEXT.byteLength });
    await expect(
      files.completeServiceDealAttachment({ fileId: uploading, userId: BUYER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      files.deleteServiceDealAttachment({ fileId: ready, userId: BUYER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await fileRow(uploading)).status).toBe('Uploading');
    expect((await fileRow(ready)).status).toBe('Ready');
  });

  it('refuses an attachment the request did not attest, even past the input schema', async () => {
    const dealId = await accepted();
    await expect(
      files.requestServiceDealAttachment({
        dealId,
        userId: BUYER,
        fileName: 'a.txt',
        mimeType: 'text/plain',
        size: 10,
        rightsAttested: true,
        likenessAttested: false,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await list(dealId, BUYER)).toEqual([]);
  });

  it('refuses a seller upload of kind Attachment, even past the input schema', async () => {
    const dealId = await accepted();
    await expect(
      files.requestServiceDealUpload({
        dealId,
        userId: SELLER,
        kind: 'Attachment' as 'Final',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        size: 10,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await list(dealId, SELLER)).toEqual([]);
  });

  it('does not complete an attachment once the deal is delivered while the upload is checked', async () => {
    const dealId = await accepted();
    const { fileId } = await requestAs(dealId, BUYER);
    let first = true;
    s3.headObject.mockImplementation(async () => {
      // The seller delivers between the lookup and the move.
      if (first) await setStatus(dealId, 'Delivered');
      first = false;
      return { status: 'present', size: TEXT.byteLength };
    });
    s3.send.mockResolvedValue(body(TEXT));
    await expect(
      files.completeServiceDealAttachment({ fileId, userId: BUYER })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await fileRow(fileId)).status).toBe('Uploading');
  });
});

describe('a moderator', () => {
  it('who is the seller sees an unscanned attachment only as the seller does', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    expect(await list(dealId, SELLER, true)).toEqual([]);
    expect(await download(fileId, SELLER, true)).toBeNull();
    expect(await list(dealId, STRANGER, true)).toEqual([
      expect.objectContaining({ id: fileId, canDownload: true }),
    ]);
    expect(await download(fileId, STRANGER, true)).not.toBeNull();
  });

  it('is not served an attachment still at the key its uploader was given', async () => {
    const dealId = await accepted();
    const request = () =>
      files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        size: TEXT.byteLength,
      });
    const { fileId: refused } = await request();
    s3.headObject.mockResolvedValue({ status: 'present', size: TEXT.byteLength + 1 });
    s3.send.mockResolvedValue({});
    await expect(
      files.completeServiceDealAttachment({ fileId: refused, userId: BUYER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const { fileId: neverCompleted } = await request();

    for (const fileId of [refused, neverCompleted]) {
      const row = await fileRow(fileId);
      expect(row.s3Key).toMatch(/^service-deals\/uploads\//);
      expect(await download(fileId, STRANGER, true)).toBeNull();
    }
    expect((await fileRow(refused)).status).toBe('Failed');

    // Its uploader is still served it: the seller's own Final, not yet completed.
    const { fileId: sellerUpload } = await files.requestServiceDealUpload({
      dealId,
      userId: SELLER,
      kind: 'Final',
      fileName: 'result.txt',
      mimeType: 'text/plain',
      size: TEXT.byteLength,
    });
    const uploaderKey = (await fileRow(sellerUpload)).s3Key;
    expect(uploaderKey).toMatch(/^service-deals\/uploads\//);
    expect((await download(sellerUpload, SELLER))?.key).toBe(uploaderKey);
    expect(await download(sellerUpload, STRANGER, true)).toBeNull();
  });

  it("reads the buyer's attachments apart from the delivery in the dispute evidence", async () => {
    const dealId = await accepted();
    const attachmentId = await attach(dealId, 'notes.txt', TEXT);
    const finalId = await final(dealId, 'result.txt', TEXT);
    const evidence = await reviews.getServiceDisputeEvidence({ dealId, viewerId: STRANGER });
    expect(evidence.files.map((file) => file.id)).toEqual([finalId]);
    expect(evidence.attachments.map((file) => file.id)).toEqual([attachmentId]);
  });
});

describe('removing a file that must be kept', () => {
  it("keeps the original of a rejected attachment the buyer removes, out of everyone's reach", async () => {
    const dealId = await accepted();
    const fileId = await rejectedZip(dealId, attach);
    const { s3Key } = await fileRow(fileId);
    const [entry] = await entries(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await keptRows(fileId)).toEqual([{ s3Key, status: 'Ready' }]);
    expect((await entries(fileId)).map((e) => e.id)).toEqual([entry.id]);
    expect(deletedKeys()).not.toContain(s3Key);
    expect(await list(dealId, BUYER)).toEqual([]);
    expect(await list(dealId, SELLER)).toEqual([]);
    expect(await download(fileId, BUYER)).toBeNull();
    expect(await download(fileId, SELLER)).toBeNull();
    // A moderator who is not a party still finds it, marked removed.
    expect(await list(dealId, STRANGER, true)).toMatchObject([
      { id: fileId, removedAt: expect.any(Date), canDownload: true },
    ]);
    expect((await download(fileId, STRANGER, true))?.key).toBe(s3Key);
    // A moderator without the csamReports permission is told it exists, and served nothing.
    expect(await list(dealId, STRANGER, true, false)).toMatchObject([
      { id: fileId, canDownload: false },
    ]);
    expect(await download(fileId, STRANGER, true, false)).toBeNull();
  });

  it('keeps the original of a rejected Final the seller removes', async () => {
    const dealId = await accepted();
    const fileId = await rejectedZip(dealId, (id, name, content) => final(id, name, content));
    const { s3Key, status } = await fileRow(fileId);
    // A failed scan leaves the Final Ready, and its seller can still take it back.
    expect(status).toBe('Ready');
    expect(await download(fileId, SELLER)).not.toBeNull();
    s3.deleteObject.mockClear();

    await files.deleteServiceDealFile({ fileId, userId: SELLER });

    expect(await keptRows(fileId)).toMatchObject([{ s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
  });

  it('keeps a file whose images are still being scanned', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();
    const { s3Key } = await fileRow(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await keptRows(fileId)).toMatchObject([{ s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
  });

  it('keeps any file of an uploader under an account hold', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { s3Key } = await fileRow(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await keptRows(fileId)).toMatchObject([{ s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
  });

  it('holds a file deleted while it is being unpacked, and the copy made after attaches to it', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    const { s3Key } = await fileRow(fileId);
    const copy = preview.entryCopy.getMockImplementation()!;
    preview.entryCopy.mockImplementationOnce(async (...args: unknown[]) => {
      // The buyer removes the file while the job is making the image's scan copy.
      await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
      return copy(...args);
    });
    s3.deleteObject.mockClear();
    await unpack.unpackFinals();

    expect(await keptRows(fileId)).toMatchObject([{ s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
    const rows = await q<{ fileId: number | null; imageId: number | null }>(
      `SELECT "fileId", "imageId" FROM "ServiceDealFileEntry"`
    );
    expect(rows).toEqual([{ fileId, imageId: expect.any(Number) }]);
    expect(await q(`SELECT id FROM "Image"`)).toEqual([{ id: rows[0].imageId }]);
  });

  it('holds a file the unpack job has claimed but not listed yet', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = now() WHERE id = $1`, [fileId]);
    expect(await entries(fileId)).toEqual([]);
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    expect(await keptRows(fileId)).toHaveLength(1);
  });

  it.each([
    ['its size does not match', 'big.txt', TEXT, TEXT.byteLength + 1],
    ['it is not a zip', 'fake.zip', TEXT, TEXT.byteLength],
  ])(
    'keeps the server copy of an upload refused because %s, under an account hold',
    async (_, name, content, size) => {
      const dealId = await accepted();
      await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
      const { fileId } = await files.requestServiceDealAttachment({
        ...ATTESTED,
        dealId,
        userId: BUYER,
        fileName: name,
        mimeType: 'application/octet-stream',
        size: content.byteLength,
      });
      const uploaderKey = (await fileRow(fileId)).s3Key;
      s3.headObject
        .mockResolvedValueOnce({ status: 'present', size: content.byteLength })
        .mockResolvedValueOnce({ status: 'present', size });
      s3.send.mockResolvedValue(body(content));
      s3.deleteObject.mockClear();
      await expect(
        files.completeServiceDealAttachment({ fileId, userId: BUYER })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // The row points at the server copy, and is otherwise the Failed file the buyer is shown.
      const refused = await fileRow(fileId);
      expect(refused).toMatchObject({ status: 'Failed', removedAt: null });
      expect(refused.s3Key).toMatch(/^service-deals\/files\//);
      expect(deletedKeys()).toEqual([uploaderKey]);
      expect(await list(dealId, BUYER)).toMatchObject([{ id: fileId, status: 'Failed' }]);
      expect(await download(fileId, BUYER)).toBeNull();
      expect(copiesTo(refused.s3Key)).toEqual([uploaderKey]);

      // The buyer then removes the refused file: kept, still at the server copy.
      await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
      expect(await keptRows(fileId)).toEqual([{ s3Key: refused.s3Key, status: 'Failed' }]);
      // Nor is a second copy made from the uploader's key, which they can still write to.
      expect(
        s3.send.mock.calls.filter(([command]) =>
          (command as { input?: { Key?: string } }).input?.Key?.startsWith('service-deals/held/')
        )
      ).toEqual([]);
    }
  );

  it.each([
    ['its size does not match', 'big.txt', TEXT.byteLength + 1],
    ['it is not a zip', 'fake.zip', TEXT.byteLength],
  ])('deletes both copies of an upload refused because %s, with no hold', async (_, name, size) => {
    const dealId = await accepted();
    const { fileId } = await requestAs(dealId, BUYER);
    await q(`UPDATE "ServiceDealFile" SET "fileName" = $2 WHERE id = $1`, [fileId, name]);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.headObject
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength })
      .mockResolvedValueOnce({ status: 'present', size });
    s3.send.mockResolvedValue(body(TEXT));
    s3.deleteObject.mockClear();
    await expect(
      files.completeServiceDealAttachment({ fileId, userId: BUYER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await fileRow(fileId)).s3Key).toBe(uploaderKey);
    expect(deletedKeys()).toHaveLength(2);
  });

  it('keeps the upload where it is when the server copy of a kept upload cannot be made', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.send.mockRejectedValue(new Error('copy failed'));
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await keptRows(fileId)).toMatchObject([{ s3Key: uploaderKey }]);
    // Not deleted on a failed copy: it may be the only one there is.
    expect(deletedKeys()).toEqual([]);
    // Nor served as what it was: the uploader can still write to it.
    expect(await download(fileId, STRANGER, true)).toBeNull();
  });

  it('tries the server copy of a held upload again before giving up', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    s3.send.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({});
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    const [kept] = await keptRows(fileId);
    expect(kept.s3Key).toMatch(/^service-deals\/held\//);
  });

  it('never records the key of a refused upload that comes under a hold later', async () => {
    const dealId = await accepted();
    const { fileId } = await requestAs(dealId, BUYER);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.headObject
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength })
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength + 1 });
    s3.send.mockResolvedValue(body(TEXT));
    await expect(
      files.completeServiceDealAttachment({ fileId, userId: BUYER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await fileRow(fileId)).s3Key).toBe(uploaderKey);

    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    const [kept] = await keptRows(fileId);
    expect(kept.s3Key).toMatch(/^service-deals\/held\//);
  });

  it('never records the key the uploader can still write to', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    const [kept] = await keptRows(fileId);
    expect(kept.s3Key).toMatch(/^service-deals\/held\//);
    expect(copiesTo(kept.s3Key)).toEqual([uploaderKey]);
    expect(deletedKeys()).toEqual([uploaderKey]);
  });

  it('deletes a file whose images all passed, and one with no images', async () => {
    const dealId = await accepted();
    const zipId = await attach(dealId, 'dataset.zip', buildZip([{ name: 'a.png', data: IMAGE_A }]));
    const textId = await attach(dealId, 'notes.txt', TEXT);
    await unpack.unpackFinals();
    await verdict('Scanned');
    await scanned([zipId, textId]);
    expect((await fileRow(zipId)).scanStatus).toBe('Passed');
    const keys = [(await fileRow(zipId)).s3Key, (await fileRow(textId)).s3Key];
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId: zipId, userId: BUYER });
    await files.deleteServiceDealAttachment({ fileId: textId, userId: BUYER });
    await agedPurge();

    expect(await fileRow(zipId)).toBeUndefined();
    expect(await fileRow(textId)).toBeUndefined();
    expect(deletedKeys()).toEqual(expect.arrayContaining(keys));
  });
});

describe('a removed file that is kept', () => {
  /** A Final the seller removes while their account is on a report, so it is kept. */
  async function removedFinal(dealId: number) {
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [SELLER]);
    const fileId = await final(dealId, 'old.txt', TEXT);
    await files.deleteServiceDealFile({ fileId, userId: SELLER });
    expect(await keptRows(fileId)).toHaveLength(1);
    return fileId;
  }

  it('neither gates delivery or payout, nor is listed or served for the parties', async () => {
    const dealId = await accepted();
    const removedId = await removedFinal(dealId);
    const liveId = await final(dealId, 'new.txt', TEXT);
    await scanned([liveId]);
    expect((await fileRow(liveId)).scanStatus).toBe('Passed');

    // The removed Final is scanned too, so it gets a verdict, but the round does not wait for it.
    expect((await fileRow(removedId)).unpackedAt).not.toBeNull();
    expect(await readyToDeliver(dealId)).toBe(true);
    expect(await finalsClear(dealId)).toBe(true);
    expect((await list(dealId, SELLER)).map((f) => f.id)).toEqual([liveId]);
    expect((await list(dealId, BUYER)).map((f) => f.id)).not.toContain(removedId);
    expect(await download(removedId, SELLER)).toBeNull();
    // Nor can its uploader complete or remove it again.
    await expect(
      files.deleteServiceDealFile({ fileId: removedId, userId: SELLER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('frees its place in the attachment limit', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    s3.send.mockResolvedValue({});
    const ids: number[] = [];
    for (let i = 0; i < SERVICE_ATTACHMENT_MAX_FILES; i++)
      ids.push((await requestAs(dealId, BUYER)).fileId);
    await files.deleteServiceDealAttachment({ fileId: ids[0], userId: BUYER });
    expect(await keptRows(ids[0])).toHaveLength(1);
    await expect(requestAs(dealId, BUYER)).resolves.toMatchObject({ fileId: expect.any(Number) });
  });

  it("serves nothing of a refused upload to its uploader, though the server's copy is kept", async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [SELLER]);
    const { fileId } = await files.requestServiceDealUpload({
      dealId,
      userId: SELLER,
      kind: 'Final',
      fileName: 'big.txt',
      mimeType: 'text/plain',
      size: TEXT.byteLength,
    });
    s3.headObject
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength })
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength + 1 });
    s3.send.mockResolvedValue(body(TEXT));
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
    const { status, s3Key } = await fileRow(fileId);
    expect(status).toBe('Failed');
    expect(s3Key).toMatch(/^service-deals\/files\//);
    expect(await download(fileId, SELLER)).toBeNull();
    expect(await download(fileId, SELLER, true)).toBeNull();
    expect((await download(fileId, STRANGER, true))?.key).toBe(s3Key);
  });

  /** A Final removed while its malware scan is in flight: kept until the verdict lands. */
  async function removedInFlight(dealId: number) {
    const fileId = await final(dealId, 'late.txt', TEXT);
    await unpack.unpackFinals();
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = now() WHERE id = $1`, [fileId]);
    await files.deleteServiceDealFile({ fileId, userId: SELLER });
    expect(await keptRows(fileId)).toHaveLength(1);
    return fileId;
  }
  const verdictLands = (fileId: number, malware: string) =>
    q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = $2::"ServiceDealFileScanStatus",
         "repackedAt" = COALESCE("repackedAt", now()), "processingAt" = NULL WHERE id = $1`,
      [fileId, malware]
    );

  it('goes for good once a scan that was running passes', async () => {
    const dealId = await accepted();
    const fileId = await removedInFlight(dealId);
    const { s3Key } = await fileRow(fileId);
    expect(await agedPurge()).toBe(0);

    await verdictLands(fileId, 'Passed');
    await settle();
    s3.deleteObject.mockClear();
    expect(await agedPurge()).toBe(1);
    expect(await fileRow(fileId)).toBeUndefined();
    expect(deletedKeys()).toContain(s3Key);
  });

  it('stays when that scan fails, has no verdict yet, or its uploader is on a report', async () => {
    const dealId = await accepted();
    const failedId = await removedInFlight(dealId);
    await verdictLands(failedId, 'Failed');
    // The run let go of it before any verdict: nothing is open on the row, but nothing passed.
    const unjudgedId = await removedInFlight(dealId);
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE id = $1`, [unjudgedId]);
    await settle();
    expect((await fileRow(failedId)).scanStatus).toBe('Failed');
    expect((await fileRow(unjudgedId)).scanStatus).toBe('Pending');
    expect(await agedPurge()).toBe(0);
    expect(await keptRows(failedId)).toHaveLength(1);
    expect(await keptRows(unjudgedId)).toHaveLength(1);

    const reportedId = await removedInFlight(dealId);
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [SELLER]);
    await verdictLands(reportedId, 'Passed');
    await settle();
    expect((await fileRow(reportedId)).scanStatus).toBe('Passed');
    expect(await agedPurge()).toBe(0);
    expect(await keptRows(reportedId)).toHaveLength(1);
  });

  it('waits for its scan copies to be deleted before it goes', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();
    // Removed while its image is still being scanned, so it is kept.
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    expect(await keptRows(fileId)).toHaveLength(1);
    await verdict('Scanned');
    await verdictLands(fileId, 'Passed');
    await settle();
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
    const [{ imageId }] = await entries(fileId);
    expect(imageId).not.toBeNull();

    expect(await agedPurge()).toBe(0);
    expect(await keptRows(fileId)).toHaveLength(1);

    expect(await unpack.deleteEntryScanCopies()).toBe(1);
    expect(await agedPurge()).toBe(1);
    expect(await fileRow(fileId)).toBeUndefined();
    expect(await q(`SELECT id FROM "Image" WHERE id = $1`, [imageId])).toEqual([]);
  });

  it('holds nothing when its malware scan is given up after the round was delivered', async () => {
    const dealId = await accepted();
    const removedId = await removedInFlight(dealId);
    await delivered(dealId);
    await q(
      `UPDATE "ServiceDealFile" SET "processingAt" = NULL, "malwareScanWorkflowId" = NULL,
         "malwareScanStartedAt" = NULL, "repackedAt" = now() - interval '2 days' WHERE id = $1`,
      [removedId]
    );
    await unpack.settleMalwareScans();
    await settle();
    expect((await fileRow(removedId)).scanStatus).toBe('Failed');
    expect(await dealStatus(dealId)).toEqual({ status: 'Delivered', disputeReason: null });
  });

  it('holds nothing when it truly fails after the round was delivered, and logs it', async () => {
    const dealId = await accepted();
    const removedId = await removedInFlight(dealId);
    await delivered(dealId);
    loggingMock.logToAxiom.mockClear();
    await verdictLands(removedId, 'Failed');
    await settle();
    expect((await fileRow(removedId)).scanStatus).toBe('Failed');
    expect(await keptRows(removedId)).toHaveLength(1);
    expect(await dealStatus(dealId)).toEqual({ status: 'Delivered', disputeReason: null });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'service-deal-file-removed-failed',
        details: expect.objectContaining({ fileId: removedId, dealId }),
      })
    );
  });
});

describe('what the seller can see', () => {
  it('nothing while the scan is running, and the delivery copy once it passed', async () => {
    const dealId = await accepted();
    const fileId = await attach(
      dealId,
      'dataset.zip',
      buildZip([{ name: 'a.png', data: IMAGE_A }])
    );
    await unpack.unpackFinals();

    expect(await list(dealId, SELLER)).toEqual([]);
    expect(await download(fileId, SELLER)).toBeNull();
    // The buyer sees their own file and its state; a moderator sees it too.
    expect(await list(dealId, BUYER)).toMatchObject([
      { id: fileId, scanStatus: 'Pending', canDownload: true },
    ]);
    expect(await list(dealId, 99, true)).toHaveLength(1);

    // The server-built archive, as the scan judged it.
    await q(
      `UPDATE "ServiceDealFile" SET "deliveryKey" = 'service-deals/delivered/x', "deliverySize" = 7 WHERE id = $1`,
      [fileId]
    );
    await verdict('Scanned');
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now()`);
    await settle();

    expect(await list(dealId, SELLER)).toMatchObject([
      { id: fileId, fileName: 'dataset.zip', size: 7, failReason: null, canDownload: true },
    ]);
    expect(await download(fileId, SELLER)).toMatchObject({
      key: 'service-deals/delivered/x',
      access: { role: 'Seller' },
    });
    // The buyer takes back their own upload.
    expect((await download(fileId, BUYER))?.key).toBe((await fileRow(fileId)).s3Key);
  });

  it('no download of a plain file until its scans pass', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await unpack.unpackFinals();
    expect(await download(fileId, SELLER)).toBeNull();
    await scanned([fileId]);
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
    expect((await download(fileId, SELLER))?.key).toBe((await fileRow(fileId)).s3Key);
  });

  it('never the original of a zip that has no server-built copy', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'dataset.zip', buildZip([{ name: 'a.txt', data: TEXT }]));
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [fileId]
    );
    expect(await download(fileId, SELLER)).toBeNull();
  });

  const CLOSED = ['Declined', 'Expired', 'Cancelled'];
  it.each(ALL_STATUSES)(
    'a passed attachment on a %s deal: the seller only while the deal did not end unworked',
    async (status) => {
      const dealId = await accepted();
      const fileId = await attach(dealId, 'notes.txt', TEXT);
      await scanned([fileId]);
      expect((await fileRow(fileId)).scanStatus).toBe('Passed');
      await setStatus(dealId, status);

      const sellerKeeps = !CLOSED.includes(status);
      expect(await list(dealId, SELLER)).toHaveLength(sellerKeeps ? 1 : 0);
      expect((await download(fileId, SELLER)) !== null).toBe(sellerKeeps);
      // A moderator keeps it for review, and the buyer keeps their own.
      expect(await list(dealId, STRANGER, true)).toHaveLength(1);
      expect(await download(fileId, STRANGER, true)).not.toBeNull();
      expect(await download(fileId, BUYER)).not.toBeNull();
    }
  );
});

describe('attachments take no part in delivery, acceptance or payout', () => {
  it('a Passed attachment does not count as a Final', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await scanned([fileId]);
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
    expect(await readyToDeliver(dealId)).toBe(false);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it.each([
    ['Pending', null],
    ['Failed', 'Failed'],
  ])('a %s attachment does not block delivery', async (_state, malware) => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    if (malware) await scanned([fileId], { malware });
    const finalId = await final(dealId, 'result.txt', TEXT);
    await scanned([finalId]);
    expect(await readyToDeliver(dealId)).toBe(true);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).resolves.toBeTruthy();
  });

  it.each([
    [
      'Uploading',
      `UPDATE "ServiceDealFile" SET status = 'Uploading' WHERE kind::text = 'Attachment'`,
    ],
    [
      'Processing',
      `UPDATE "ServiceDealFile" SET status = 'Processing' WHERE kind::text = 'Attachment'`,
    ],
    ['Ready and not yet unpacked', null],
  ])('an attachment that is %s does not block delivery', async (_state, sql) => {
    const dealId = await accepted();
    const finalId = await final(dealId, 'result.txt', TEXT);
    await scanned([finalId]);
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    if (sql) await q(sql);
    expect((await fileRow(fileId)).unpackedAt).toBeNull();
    expect(await readyToDeliver(dealId)).toBe(true);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).resolves.toBeTruthy();
  });

  it.each([
    ['Pending', null],
    ['Failed', 'Failed'],
  ])('a %s attachment does not block acceptance or payout', async (_state, malware) => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await delivered(dealId);
    if (malware) await scanned([fileId], { malware });
    expect((await fileRow(fileId)).scanStatus).toBe(malware ?? 'Pending');

    // `dealFinalsClear` is what both acceptance and the Release leg require.
    expect(await finalsClear(dealId)).toBe(true);
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    expect((await dealStatus(dealId)).status).toBe('Completed');
  });
});

describe('review images', () => {
  const ART = Buffer.from('final-art-bytes');

  /** A completed, review-enrolled deal whose one Final is a still image, with a review row. */
  async function reviewed({ allow = true } = {}) {
    const dealId = await accepted();
    const finalId = await delivered(dealId);
    await q(`UPDATE "ServiceDealFile" SET "mimeType" = 'image/png' WHERE id = $1`, [finalId]);
    bucket.objects.set((await fileRow(finalId)).s3Key, ART);
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    await q(`UPDATE "ServiceDeal" SET "reviewEnabledAt" = now() WHERE id = $1`, [dealId]);
    await q(`UPDATE "ServiceOffering" SET "allowReviewWork" = $1`, [allow]);
    await q(
      `INSERT INTO "ServiceDealReview" ("dealId", "offeringId", "sellerId", "buyerId", verdict, "scanStatus", "editableUntil", "updatedAt")
       SELECT id, "offeringId", "sellerId", "buyerId", 'Happy', 'Scanned', now(), now() FROM "ServiceDeal" WHERE id = $1`,
      [dealId]
    );
    return { dealId, finalId };
  }
  const picker = async (dealId: number, userId = BUYER) =>
    (await reviewImages.listReviewAttachableFinals({ dealId, userId })).map((f) => f.id);
  const attachFinal = async (dealId: number, fileId: number, userId = BUYER) =>
    reviewImages.attachFinalToReview({ dealId, userId, fileId, reviewFlag: true });
  const linked = () =>
    q<{ sourceFileId: number; imageId: number }>(
      `SELECT "sourceFileId", "imageId" FROM "ServiceDealReviewImage" ORDER BY "imageId"`
    );
  const refused = expect.objectContaining({ code: 'CONFLICT' });

  beforeEach(() => {
    s3.send.mockImplementation(async (command: { input: { Key: string } }) =>
      body(bucket.objects.get(command.input.Key) ?? Buffer.alloc(0))
    );
    preview.entryCopy.mockResolvedValue({
      data: SCAN_COPY(1),
      mimeType: 'image/webp',
      width: 10,
      height: 10,
      frames: 1,
    });
  });

  it("offers the deal's scanned image final, and attaches a fresh copy owned by the buyer", async () => {
    const { dealId, finalId } = await reviewed();
    expect(await picker(dealId)).toEqual([finalId]);
    const { imageId } = await attachFinal(dealId, finalId);
    expect(images.createImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: BUYER, url: expect.stringMatching(/^scan-key-/) })
    );
    expect(await linked()).toEqual([{ sourceFileId: finalId, imageId }]);
    // Once per final.
    expect(await picker(dealId)).toEqual([]);
    await expect(attachFinal(dealId, finalId)).rejects.toEqual(refused);
  });

  it('offers nothing when the seller does not allow review work, or the deal was ever disputed', async () => {
    const { dealId, finalId } = await reviewed({ allow: false });
    expect(await picker(dealId)).toEqual([]);
    await expect(attachFinal(dealId, finalId)).rejects.toEqual(refused);
    await q(`UPDATE "ServiceOffering" SET "allowReviewWork" = true`);
    await q(`UPDATE "ServiceDeal" SET "disputeOpenedAt" = now() WHERE id = $1`, [dealId]);
    expect(await picker(dealId)).toEqual([]);
  });

  it('refuses a file of another deal, a file that is not a Final, a non-image, and the seller', async () => {
    const { dealId, finalId } = await reviewed();
    const other = await reviewed();
    await expect(attachFinal(dealId, other.finalId)).rejects.toEqual(refused);
    await expect(attachFinal(dealId, finalId, SELLER)).rejects.toEqual(refused);
    await q(`UPDATE "ServiceDealFile" SET "mimeType" = 'application/zip' WHERE id = $1`, [finalId]);
    await expect(attachFinal(dealId, finalId)).rejects.toEqual(refused);
    await q(`UPDATE "ServiceDealFile" SET "mimeType" = 'image/png' WHERE id = $1`, [finalId]);
    // A scanned image of the same deal and round that is not a Final, beside the Final that clears it.
    const [{ id: notFinal }] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealFile" ("dealId", round, kind, "s3Key", "mimeType", size, status, "scanStatus", "malwareScanStatus")
       SELECT "dealId", round, 'Attachment', "s3Key" || '-attachment', "mimeType", size, status, "scanStatus", "malwareScanStatus"
       FROM "ServiceDealFile" WHERE id = $1 RETURNING id`,
      [finalId]
    );
    expect(await picker(dealId)).toEqual([finalId]);
    await expect(attachFinal(dealId, notFinal)).rejects.toEqual(refused);
    expect(await linked()).toEqual([]);
    expect(images.createImage).not.toHaveBeenCalledWith(expect.objectContaining({ userId: BUYER }));
  });

  it('deletes a copy that lost its slot to another attach while it was made', async () => {
    const { dealId, finalId } = await reviewed();
    preview.entryCopy.mockImplementationOnce(async () => {
      // Another request links the same final while this one copies it.
      const [{ id: reviewId }] = await q<{ id: number }>(
        `SELECT id FROM "ServiceDealReview" WHERE "dealId" = $1`,
        [dealId]
      );
      const [{ id }] = await q<{ id: number }>(
        `INSERT INTO "Image" (url) VALUES ('w') RETURNING id`
      );
      await q(
        `INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId", "sourceFileId") VALUES ($1, $2, $3)`,
        [reviewId, id, finalId]
      );
      return { data: SCAN_COPY(2), mimeType: 'image/webp', width: 10, height: 10, frames: 1 };
    });
    await expect(attachFinal(dealId, finalId)).rejects.toEqual(refused);
    const lost = (await images.createImage.mock.results.at(-1)!.value) as { id: number };
    expect(images.deleteImages).toHaveBeenCalledWith([lost.id], expect.anything());
    expect(await linked()).toHaveLength(1);
  });

  it('stops at the cap', async () => {
    const { dealId, finalId } = await reviewed();
    const [{ id: reviewId }] = await q<{ id: number }>(
      `SELECT id FROM "ServiceDealReview" WHERE "dealId" = $1`,
      [dealId]
    );
    const seedImage = async () => {
      const [{ id }] = await q<{ id: number }>(
        `INSERT INTO "Image" (url) VALUES ('x') RETURNING id`
      );
      await q(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES ($1, $2)`, [
        reviewId,
        id,
      ]);
    };
    for (let i = 0; i < 3; i++) await seedImage();
    expect(await picker(dealId)).toEqual([finalId]);
    await seedImage();
    expect(await picker(dealId)).toEqual([]);
  });

  it("rates a review image at its deal's level, so an X deal's PG image never shows at SFW levels", async () => {
    const { dealId, finalId } = await reviewed();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 8 WHERE id = $1`, [dealId]);
    const { imageId } = await attachFinal(dealId, finalId);
    const [{ id: reviewId }] = await q<{ id: number }>(
      `SELECT id FROM "ServiceDealReview" WHERE "dealId" = $1`,
      [dealId]
    );
    const shown = async (levels: number) =>
      (await reviewImages.getReviewImages({ reviewId, levels })).map((i) => [i.id, i.nsfwLevel]);
    // Unscanned: not shown at any level.
    expect(await shown(31)).toEqual([]);
    await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1 WHERE id = $1`, [imageId]);
    expect(await shown(1 | 2 | 4)).toEqual([]);
    expect(await shown(31)).toEqual([[imageId, 8]]);
    // Never an image the scan flagged, or rated above the deal, or once the seller opts out.
    for (const flag of [
      'minor = true',
      'poi = true',
      `"needsReview" = 'poi'`,
      '"nsfwLevel" = 16',
    ]) {
      await q(`UPDATE "Image" SET ${flag} WHERE id = $1`, [imageId]);
      expect(await shown(31)).toEqual([]);
      await q(
        `UPDATE "Image" SET minor = false, poi = false, "needsReview" = NULL, "nsfwLevel" = 1 WHERE id = $1`,
        [imageId]
      );
    }
    expect(await shown(31)).toEqual([[imageId, 8]]);
    await q(`UPDATE "ServiceOffering" SET "allowReviewWork" = false`);
    expect(await shown(31)).toEqual([]);
  });
});

describe('reviews on the offering page', () => {
  const COM = 1 | 2;
  const RED = 31;
  beforeAll(async () => {
    // The display reads the columns an image card draws with.
    await holder.db.exec(`
      ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS hash text,
        ADD COLUMN IF NOT EXISTS width int, ADD COLUMN IF NOT EXISTS height int,
        ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'image', ADD COLUMN IF NOT EXISTS metadata jsonb;
    `);
  });

  /** A deal with a published review by `buyerId`, the deal rated `level`. */
  async function shownReview({
    buyerId = BUYER,
    level = 1,
    minutesAgo = 0,
    reply = '',
    replyStatus = 'Scanned',
  } = {}) {
    const dealId = await accepted();
    await q(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [buyerId]);
    await q(`UPDATE "ServiceDeal" SET "buyerId" = $2, "maxNsfwLevel" = $3 WHERE id = $1`, [
      dealId,
      buyerId,
      level,
    ]);
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "ServiceDealReview" ("dealId", "offeringId", "sellerId", "buyerId", verdict, comment,
         "scanStatus", "editableUntil", "updatedAt", "publishedAt", "sellerReply", "sellerReplyAt",
         "sellerReplyScanStatus")
       SELECT id, "offeringId", "sellerId", "buyerId", 'Happy', 'Lovely', 'Scanned', now(), now(),
         now() - interval '1 minute' * $2::int, NULLIF($3, ''), now(),
         '${replyStatus}'::"ServiceOfferingIngestionStatus"
       FROM "ServiceDeal" WHERE id = $1 RETURNING id`,
      [dealId, minutesAgo, reply]
    );
    return { dealId, reviewId: id };
  }
  async function shownImage(reviewId: number) {
    const [{ id }] = await q<{ id: number }>(
      `INSERT INTO "Image" (url, ingestion, "nsfwLevel", "userId") VALUES ('u', 'Scanned', 1, $1) RETURNING id`,
      [BUYER]
    );
    await q(`INSERT INTO "ServiceDealReviewImage" ("reviewId", "imageId") VALUES ($1, $2)`, [
      reviewId,
      id,
    ]);
    return id;
  }
  const list = async (levels: number, cursor?: number, limit?: number) =>
    reviewDisplay.getServiceOfferingReviews({
      offeringId: 1,
      levels,
      cursor,
      limit,
      excludedUserIds: [],
    });

  beforeEach(async () => {
    await q(`UPDATE "ServiceOffering" SET "allowReviewWork" = true`);
  });

  it('lists published reviews newest first, paged, and leaves out unpublished ones', async () => {
    const older = await shownReview({ minutesAgo: 10 });
    const newer = await shownReview({ minutesAgo: 1 });
    const hidden = await shownReview();
    await q(`UPDATE "ServiceDealReview" SET "publishedAt" = NULL WHERE id = $1`, [hidden.reviewId]);

    const first = await list(RED, undefined, 1);
    expect(first.items.map((r) => r.id)).toEqual([newer.reviewId]);
    const second = await list(RED, first.nextCursor, 1);
    expect(second.items.map((r) => r.id)).toEqual([older.reviewId]);
    expect(second.nextCursor).toBeUndefined();
  });

  it('drops a review once its buyer is banned or deleted', async () => {
    await shownReview({ buyerId: 20 });
    await shownReview({ buyerId: 21 });
    const kept = await shownReview({ buyerId: 22 });
    await q(`UPDATE "User" SET "bannedAt" = now() WHERE id = 20`);
    await q(`UPDATE "User" SET "deletedAt" = now() WHERE id = 21`);
    expect((await list(RED)).items.map((r) => r.id)).toEqual([kept.reviewId]);
  });

  it("shows an R deal's review on .red and not on .com, with its images", async () => {
    const pg = await shownReview({ level: 1, minutesAgo: 5 });
    const r = await shownReview({ level: 4 });
    const pgImage = await shownImage(pg.reviewId);
    const rImage = await shownImage(r.reviewId);

    expect((await list(COM)).items.map((x) => x.id)).toEqual([pg.reviewId]);
    expect((await list(RED)).items.map((x) => x.id)).toEqual([r.reviewId, pg.reviewId]);
    // The R deal's PG-scanned image is rated R, so it never reaches .com.
    const work = async (levels: number) =>
      (
        await reviewDisplay.getServiceOfferingReviewWork({
          offeringId: 1,
          levels,
          excludedUserIds: [],
        })
      ).items.map((i) => [i.id, i.nsfwLevel]);
    expect(await work(COM)).toEqual([[pgImage, 1]]);
    expect(await work(RED)).toEqual([
      [rImage, 4],
      [pgImage, 1],
    ]);
    expect((await list(RED)).items[0].images.map((i) => i.id)).toEqual([rImage]);
  });

  it('leaves out reviews and work by buyers the viewer hid or has a block with', async () => {
    const blocked = await shownReview({ buyerId: 30 });
    const kept = await shownReview({ buyerId: 31 });
    await shownImage(blocked.reviewId);
    const keptImage = await shownImage(kept.reviewId);
    const excludedUserIds = [30];
    expect(
      (
        await reviewDisplay.getServiceOfferingReviews({
          offeringId: 1,
          levels: RED,
          excludedUserIds,
        })
      ).items.map((r) => r.id)
    ).toEqual([kept.reviewId]);
    expect(
      (
        await reviewDisplay.getServiceOfferingReviewWork({
          offeringId: 1,
          levels: RED,
          excludedUserIds,
        })
      ).items.map((i) => i.id)
    ).toEqual([keptImage]);
    // Without an exclusion list, both are shown: hiding is the viewer's own.
    expect((await list(RED)).items).toHaveLength(2);
  });

  it('works out the viewer: levels held to the domain, and every buyer hidden or blocked either way', async () => {
    await holder.db.exec(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS username text;
      ALTER TABLE "UserEngagement" ADD COLUMN IF NOT EXISTS "createdAt" timestamp NOT NULL DEFAULT now();
    `);
    const VIEWER = 40;
    const [hid, blocked, blocker, other] = [41, 42, 43, 44];
    for (const buyerId of [hid, blocked, blocker, other]) await shownReview({ buyerId });
    await q(`INSERT INTO "User" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [VIEWER]);
    await q(
      `INSERT INTO "UserEngagement" ("userId", "targetUserId", type) VALUES
        ($1, $2, 'Hide'), ($1, $3, 'Block'), ($4, $1, 'Block')`,
      [VIEWER, hid, blocked, blocker]
    );

    const viewer = await reviewDisplay.serviceReviewViewer({
      browsingLevel: RED,
      servable: COM,
      viewerId: VIEWER,
    });
    // The domain caps what the viewer asked for.
    expect(viewer.levels).toBe(COM);
    const shown = await reviewDisplay.getServiceOfferingReviews({ offeringId: 1, ...viewer });
    const [{ id: otherReview }] = await q<{ id: number }>(
      `SELECT id FROM "ServiceDealReview" WHERE "buyerId" = $1`,
      [other]
    );
    expect(shown.items.map((r) => r.id)).toEqual([otherReview]);

    expect(await reviewDisplay.serviceReviewViewer({ servable: COM })).toEqual({
      levels: COM,
      excludedUserIds: [],
    });
  });

  it("shows the seller's reply only once it passed its check", async () => {
    const { reviewId } = await shownReview({ reply: 'Thanks!', replyStatus: 'Pending' });
    expect((await list(RED)).items[0]).toMatchObject({ id: reviewId, sellerReply: null });
    await q(`UPDATE "ServiceDealReview" SET "sellerReplyScanStatus" = 'Scanned' WHERE id = $1`, [
      reviewId,
    ]);
    expect((await list(RED)).items[0]).toMatchObject({ sellerReply: 'Thanks!' });
  });

  it('pages the received work across reviews', async () => {
    const a = await shownReview({ minutesAgo: 5 });
    const b = await shownReview();
    const older = await shownImage(a.reviewId);
    const newer = await shownImage(b.reviewId);
    const first = await reviewDisplay.getServiceOfferingReviewWork({
      offeringId: 1,
      levels: RED,
      excludedUserIds: [],
      limit: 1,
    });
    expect(first.items.map((i) => i.id)).toEqual([newer]);
    const second = await reviewDisplay.getServiceOfferingReviewWork({
      offeringId: 1,
      levels: RED,
      excludedUserIds: [],
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.id)).toEqual([older]);
  });
});
