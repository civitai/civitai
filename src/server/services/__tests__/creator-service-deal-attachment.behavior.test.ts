import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import '~/__tests__/mocks/logging.mock';
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

const images = vi.hoisted(() => ({ createImage: vi.fn(), deleteImageById: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  createImage: images.createImage,
  deleteImageById: images.deleteImageById,
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
  '20261224150000_service_deal_file_held',
  '20261224150100_service_deal_file_attachment',
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
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false);
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "Report" (id serial PRIMARY KEY);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 1);
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
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
  images.deleteImageById.mockImplementation(async ({ id }: { id: number }) => {
    await q(`DELETE FROM "Image" WHERE id = $1`, [id]);
  });
  await holder.db.exec(`
    TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image", "ServiceDealFileHeld", "CsamReport", "ServiceDisputeReview" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'None', 'Active', now());
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

const list = (dealId: number, userId: number, isModerator = false) =>
  files.listServiceDealFiles({ dealId, userId, isModerator });
const download = (fileId: number, userId: number, isModerator = false) =>
  files.resolveServiceDealFileDownload({ fileId, userId, isModerator });

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

describe('attaching', () => {
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

  it('never passes on a skipped malware scan, though a Final does while the scan is off', async () => {
    malwareScan.on.mockResolvedValue(false);
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
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

const heldRows = (fileId: number) =>
  q<{ reason: string; s3Key: string; uploaderId: number; kind: string; entryIds: number[] }>(
    `SELECT reason, "s3Key", "uploaderId", kind::text, "entryIds" FROM "ServiceDealFileHeld" WHERE "fileId" = $1`,
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
      expect(await fileRow(existing)).toBeUndefined();
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

  it("reads the buyer's attachments apart from the delivery in the dispute evidence", async () => {
    const dealId = await accepted();
    const attachmentId = await attach(dealId, 'notes.txt', TEXT);
    const finalId = await final(dealId, 'result.txt', TEXT);
    const evidence = await reviews.getServiceDisputeEvidence({ dealId, viewerId: STRANGER });
    expect(evidence.files.map((file) => file.id)).toEqual([finalId]);
    expect(evidence.attachments.map((file) => file.id)).toEqual([attachmentId]);
  });
});

describe('removing a file that is evidence', () => {
  it("keeps the original of a rejected attachment the buyer removes, out of everyone's reach", async () => {
    const dealId = await accepted();
    const fileId = await rejectedZip(dealId, attach);
    const { s3Key } = await fileRow(fileId);
    const [entry] = await entries(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await heldRows(fileId)).toEqual([
      {
        reason: 'scan',
        s3Key,
        uploaderId: BUYER,
        kind: 'Attachment',
        entryIds: [entry.id],
      },
    ]);
    expect(deletedKeys()).not.toContain(s3Key);
    expect(await fileRow(fileId)).toBeUndefined();
    expect(await list(dealId, BUYER)).toEqual([]);
    expect(await list(dealId, SELLER)).toEqual([]);
    expect(await download(fileId, BUYER)).toBeNull();
  });

  it('keeps the original of a rejected Final the seller removes', async () => {
    const dealId = await accepted();
    const fileId = await rejectedZip(dealId, (id, name, content) => final(id, name, content));
    const { s3Key } = await fileRow(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealFile({ fileId, userId: SELLER });

    expect(await heldRows(fileId)).toMatchObject([
      { reason: 'scan', s3Key, uploaderId: SELLER, kind: 'Final' },
    ]);
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

    expect(await heldRows(fileId)).toMatchObject([{ reason: 'scan', s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
  });

  it('keeps any file of an uploader under an account hold', async () => {
    const dealId = await accepted();
    const fileId = await attach(dealId, 'notes.txt', TEXT);
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { s3Key } = await fileRow(fileId);
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await heldRows(fileId)).toMatchObject([{ reason: 'account', s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
  });

  it('records the hold that applies first when two do', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const fileId = await rejectedZip(dealId, attach);
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    expect(await heldRows(fileId)).toMatchObject([{ reason: 'account' }]);
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

    expect(await heldRows(fileId)).toMatchObject([{ reason: 'scan', s3Key }]);
    expect(deletedKeys()).not.toContain(s3Key);
    const rows = await q<{ fileId: number | null; imageId: number | null }>(
      `SELECT "fileId", "imageId" FROM "ServiceDealFileEntry"`
    );
    expect(rows).toEqual([{ fileId: null, imageId: expect.any(Number) }]);
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
    expect(await heldRows(fileId)).toMatchObject([{ reason: 'scan' }]);
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

      const [held] = await heldRows(fileId);
      expect(held).toMatchObject({ reason: 'account' });
      expect(held.s3Key).toMatch(/^service-deals\/files\//);
      expect(deletedKeys()).toEqual([uploaderKey]);
      expect((await fileRow(fileId)).status).toBe('Failed');
      expect(await download(fileId, BUYER)).toBeNull();
      expect(copiesTo(held.s3Key!)).toEqual([uploaderKey]);

      // The buyer then removes the refused file: still one held row, still the server copy.
      await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
      expect(await heldRows(fileId)).toEqual([held]);
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
    s3.headObject
      .mockResolvedValueOnce({ status: 'present', size: TEXT.byteLength })
      .mockResolvedValueOnce({ status: 'present', size });
    s3.send.mockResolvedValue(body(TEXT));
    s3.deleteObject.mockClear();
    await expect(
      files.completeServiceDealAttachment({ fileId, userId: BUYER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await heldRows(fileId)).toEqual([]);
    expect(deletedKeys()).toHaveLength(2);
  });

  it('records no key at all when the server copy of a held upload cannot be made', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.send.mockRejectedValue(new Error('copy failed'));
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    expect(await heldRows(fileId)).toMatchObject([{ reason: 'account', s3Key: null }]);
    expect(deletedKeys()).toEqual([uploaderKey]);
  });

  it('tries the server copy of a held upload again before giving up', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    s3.send.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({});
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    const [held] = await heldRows(fileId);
    expect(held.s3Key).toMatch(/^service-deals\/held\//);
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
    expect(await heldRows(fileId)).toEqual([]);
    expect((await fileRow(fileId)).s3Key).toBe(uploaderKey);

    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });
    const [held] = await heldRows(fileId);
    expect(held.reason).toBe('account');
    expect(held.s3Key).not.toBe(uploaderKey);
    expect(held.s3Key).toMatch(/^service-deals\/held\//);
  });

  it('never records the key the uploader can still write to', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [BUYER]);
    const { fileId } = await requestAs(dealId, BUYER);
    const uploaderKey = (await fileRow(fileId)).s3Key;
    s3.deleteObject.mockClear();

    await files.deleteServiceDealAttachment({ fileId, userId: BUYER });

    const [held] = await heldRows(fileId);
    expect(held.s3Key).toMatch(/^service-deals\/held\//);
    expect(held.s3Key).not.toBe(uploaderKey);
    expect(copiesTo(held.s3Key!)).toEqual([uploaderKey]);
    expect(deletedKeys()).toEqual([uploaderKey]);
  });

  it('still deletes a file whose images all passed, and one with no images', async () => {
    const dealId = await accepted();
    await q(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [SELLER]);
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

    expect(await heldRows(zipId)).toEqual([]);
    expect(await heldRows(textId)).toEqual([]);
    expect(deletedKeys()).toEqual(expect.arrayContaining(keys));
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
