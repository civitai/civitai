import { Prisma } from '@prisma/client';
import { constants } from '~/server/common/constants';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { crc32, deflateSync } from 'zlib';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUYER_DISCLOSURE_VERSION } from '~/shared/constants/creator-service-terms.constants';
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
import {
  buildZip,
  JPEG_BYTES,
  MP4_BYTES,
  mp4Clip,
  PNG_BYTES,
  symlinkAttributes,
  webmClip,
  type FixtureEntry,
} from '~/server/utils/__tests__/zip-fixture';
import { childSafetyCaseTablesSql } from '~/server/services/__tests__/child-safety-case-tables';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Unpacking delivered Finals and settling their image scans, run against the real migrations on an
 * in-process Postgres. Faked: storage, the image service, the scan-copy builder, Buzz and chat.
 * The zip reader is the real one, reading real archives built in the test. Every state change and
 * verdict rule is the production SQL.
 *
 * One connection: nothing here can say anything about two runs racing each other.
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
  getImageUploadBackend: async () => ({ s3: { send: s3.send }, bucket: 'image-store' }),
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
const deals = await import('~/server/services/creator-service-deal.service');
const unpack = await import('~/server/services/creator-service-deal-unpack.service');
const escrow = await import('~/server/services/creator-service-escrow.service');
const scan = await import('~/server/services/creator-service-deal-file-scan');
const orchestrator = await import('@civitai/orchestration-client');
const { PreviewRejectedError } = await import('~/server/utils/service-deal-preview');
const {
  SERVICE_FINAL_OVER_LEVEL_REASON,
  SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR,
  SERVICE_FINAL_VIDEO_TOO_LONG,
  SERVICE_FINAL_SCAN_GIVE_UP_MS,
  SERVICE_FINAL_SCAN_MAX_ATTEMPTS,
  SERVICE_FINAL_SCAN_RETRY_MS,
  SERVICE_FINAL_SCAN_STALE_MS,
  SERVICE_UNPACK_STALE_MS,
  SERVICE_ZIP_MAX_ENTRIES,
  SERVICE_ZIP_MAX_ENTRY_BYTES,
  SERVICE_ZIP_MAX_IMAGE_BYTES,
} = await import('~/shared/constants/creator-services.constants');

const MIGRATIONS = [
  '20261025120000_creator_services_foundation',
  '20261028130000_service_deal_event_reason_code',
  '20261028140000_creator_service_deal_file_state',
  '20261028150000_creator_service_max_nsfw_level',
  '20261028160000_creator_service_deal_file_entries',
  '20261028170000_creator_service_offering_takedown',
  '20261029140000_creator_service_deal_file_delivery',
  '20261128150000_creator_service_final_malware_scan',
  '20261224150000_service_deal_file_removed_at',
  '20270106120000_service_offering_content_scan',
  '20271118230000_service_deal_file_purge',
  '20271119070000_service_deal_file_scanned_etag',
  '20271120030000_service_license_presets',
  '20271120100000_service_deal_reviewed_happy',
  '20271120100100_service_deal_reviews',
  '20271125130000_service_deal_buyer_disclosure',
  '20271128130000_service_request_form',
  '20271128140100_service_deal_file_entry_copy_delete_started_at',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const SELLER = 1;
const BUYER = 2;

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
    disclosureVersion: BUYER_DISCLOSURE_VERSION,
    disclosureReviewEnabled: false,
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

/** Four packets of `size` bytes, each opening with the sync byte. */
const tsStream = (size: number) =>
  Buffer.concat(
    [0, 1, 2, 3].map(() => Buffer.concat([Buffer.from([0x47]), Buffer.alloc(size - 1)]))
  );
/** An ID3v2.4 tag with a `body`-byte body (its size syncsafe, 7 bits a byte), and a footer if asked. */
const id3Tag = (body: number, footer = false) =>
  Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([
      4,
      0,
      footer ? 0x10 : 0,
      (body >> 21) & 0x7f,
      (body >> 14) & 0x7f,
      (body >> 7) & 0x7f,
      body & 0x7f,
    ]),
    Buffer.alloc(body),
    footer ? Buffer.concat([Buffer.from('3DI', 'latin1'), Buffer.alloc(7)]) : Buffer.alloc(0),
  ]);
const MP3_FRAME = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(600)]);
/** An MP3 whose leading ID3 tag carries a PDF header, which a player skips past. */
const pdfInId3 = () =>
  Buffer.concat([
    id3Tag(300).subarray(0, 10),
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(291),
    MP3_FRAME(),
  ]);

/** A data descriptor with its signature, carrying the checksum and sizes given. */
const descriptor = (crc: number, compressed: number, uncompressed: number) => {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(0x08074b50, 0);
  bytes.writeUInt32LE(crc >>> 0, 4);
  bytes.writeUInt32LE(compressed, 8);
  bytes.writeUInt32LE(uncompressed, 12);
  return bytes;
};
const PICKLE = () => Buffer.from([0x80, 0x02, 0x7d, 0x71, 0x00, 0x2e]);
type TorchEntry = [path: string, data: Buffer, method?: 'store' | 'deflate'];
/**
 * A checkpoint in torch's zip layout under `root`, plus `entries` under the root and `others` at
 * the paths given, stored with a data descriptor as torch writes them unless an entry says
 * otherwise. `overrides` sets header fields of the entry at a path.
 */
const torchZip = (
  entries: TorchEntry[],
  root = 'weights',
  others: TorchEntry[] = [],
  overrides: Record<string, Partial<FixtureEntry>> = {}
) =>
  buildZip(
    [
      [`${root}/data.pkl`, PICKLE()] as TorchEntry,
      [`${root}/version`, Buffer.from('3\n')] as TorchEntry,
      ...entries.map(([path, data, method]): TorchEntry => [`${root}/${path}`, data, method]),
      ...others,
    ].map(([name, data, method]) => ({
      name,
      data,
      method: method ?? 'store',
      descriptor: method !== 'deflate',
      ...overrides[name],
    }))
  );

const zipFinal = (dealId: number, items: FixtureEntry[]) =>
  final(dealId, 'result.zip', buildZip(items));

const IMAGE_A = PNG_BYTES(100);
const IMAGE_B = JPEG_BYTES(200);
const SCAN_COPY = (n: number) => Buffer.from(`scan-copy-${n}`);

/** Marks every Image as scanned with a verdict. */
const verdict = (ingestion: string, extra = '', level = 1) =>
  q(`UPDATE "Image" SET ingestion = $1::"ImageIngestionStatus", "nsfwLevel" = ${level}${extra}`, [
    ingestion,
  ]);

/** Moves a file's claim back in time, as the clock would. */
const ageClaim = (fileId: number, ms: number) =>
  q(
    `UPDATE "ServiceDealFile" SET "processingAt" = now() - ($2::int * interval '1 millisecond') WHERE id = $1`,
    [fileId, ms]
  );

const settle = async () => {
  await unpack.settleEntryScans();
  return unpack.settleFinals();
};

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
    CREATE TABLE "Appeal" (id serial PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL);
    CREATE TABLE "ModActivity" (id serial PRIMARY KEY, "entityType" text, "entityId" int, activity text NOT NULL);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (id serial PRIMARY KEY, url text, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending',
      "needsReview" text, poi boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false, "nsfwLevel" int NOT NULL DEFAULT 1,
      "tosViolation" boolean NOT NULL DEFAULT false);
  `);
  for (const migration of MIGRATIONS) await holder.db.exec(readFileSync(migration, 'utf8'));
  await holder.db.exec(childSafetyCaseTablesSql);
  // The deal holds a party's delete reads.
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
  images.deleteImages.mockImplementation(async (ids: number[]) =>
    q(`DELETE FROM "Image" WHERE id = ANY($1::int[]) RETURNING id`, [ids])
  );
  await holder.db.exec(`
    TRUNCATE "ServiceDealFilePurge", "ServiceDealReviewImage", "ServiceDealReview", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image", "Report", "ImageReport", "CsamReport", "CsamQueueSetAside" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, ingestion, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'None', 'Active', 'Scanned', now());
  `);
});

describe('unpacking a zip', () => {
  it('reads the server-held copy, submits a downscaled copy of every image, and judges nothing yet', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'one.png', data: IMAGE_A },
      { name: 'docs/readme.txt', data: Buffer.from('hello there, this is a note') },
      { name: 'two.JPG', data: IMAGE_B },
    ]);
    const held = (await fileRow(fileId)).s3Key;

    expect(await unpack.unpackFinals()).toBe(1);

    // The archive was read from the server's copy, never from the seller's upload key.
    expect(new Set(bucket.zipReads)).toEqual(new Set([held]));
    expect(held).toMatch(/^service-deals\/files\//);

    // Only the images were turned into scan copies, from their exact bytes.
    expect(preview.entryCopy).toHaveBeenCalledTimes(2);
    expect(preview.entryCopy.mock.calls[0][0].equals(IMAGE_A)).toBe(true);
    expect(preview.entryCopy.mock.calls[1][0].equals(IMAGE_B)).toBe(true);
    expect(images.createImage).toHaveBeenCalledTimes(2);
    // Ingestion is NOT skipped: this is a real scan, owned by the seller.
    for (const [created] of images.createImage.mock.calls) {
      expect(created).toMatchObject({ userId: SELLER, type: 'image' });
      expect(created).not.toHaveProperty('skipIngestion');
    }

    const rows = await entries(fileId);
    expect(rows.map((r) => [r.entryIndex, r.path, r.scanStatus, r.scanKey])).toEqual([
      [0, 'one.png', 'Pending', 'scan-key-1'],
      [2, 'two.JPG', 'Pending', 'scan-key-2'],
    ]);
    expect(rows.every((r) => r.imageId !== null)).toBe(true);

    const file = await fileRow(fileId);
    expect(file.unpackedAt).not.toBeNull();
    expect(file.processingAt).toBeNull();
    expect(file.scanStatus).toBe('Pending');
  });

  it('takes one archive per run, oldest first', async () => {
    const dealId = await accepted();
    const first = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    const second = await zipFinal(dealId, [{ name: 'b.png', data: IMAGE_A }]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(first)).unpackedAt).not.toBeNull();
    expect((await fileRow(second)).unpackedAt).toBeNull();
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(second)).unpackedAt).not.toBeNull();
    expect(await unpack.unpackFinals()).toBe(0);
  });

  it('does not claim what it must not: a held, an unpacked, a failed or a preview file', async () => {
    const dealId = await accepted();
    const held = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = now() WHERE id = $1`, [held]);
    expect(await unpack.unpackFinals()).toBe(0);

    // A claim gone stale is taken up again; the same claim a moment younger is not.
    await q(
      `UPDATE "ServiceDealFile" SET "processingAt" = now() - ($2::int * interval '1 millisecond') WHERE id = $1`,
      [held, SERVICE_UNPACK_STALE_MS - 60_000]
    );
    expect(await unpack.unpackFinals()).toBe(0);
    await q(
      `UPDATE "ServiceDealFile" SET "processingAt" = now() - ($2::int * interval '1 millisecond') WHERE id = $1`,
      [held, SERVICE_UNPACK_STALE_MS + 60_000]
    );
    expect(await unpack.unpackFinals()).toBe(1);

    expect(await unpack.unpackFinals()).toBe(0); // already unpacked
    await q(`UPDATE "ServiceDealFile" SET "unpackedAt" = NULL, status = 'Failed' WHERE id = $1`, [
      held,
    ]);
    expect(await unpack.unpackFinals()).toBe(0);
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Ready', "scanStatus" = 'Failed' WHERE id = $1`,
      [held]
    );
    expect(await unpack.unpackFinals()).toBe(0);
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Pending', kind = 'Preview' WHERE id = $1`,
      [held]
    );
    expect(await unpack.unpackFinals()).toBe(0);
  });

  it('gives the claim back and does nothing when the job is told to stop', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    expect(await unpack.unpackFinals({ shouldStop: () => true })).toBe(0);
    expect(images.createImage).not.toHaveBeenCalled();
    expect(await entries(fileId)).toEqual([]);
    const file = await fileRow(fileId);
    expect(file).toMatchObject({ unpackedAt: null, processingAt: null });
    // Released, so the next run takes it.
    expect(await unpack.unpackFinals()).toBe(1);
  });

  it('stops between the check and the scan too, leaving the rows and the claim released', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    let calls = 0;
    expect(await unpack.unpackFinals({ shouldStop: () => ++calls > 1 })).toBe(0);
    expect(images.createImage).not.toHaveBeenCalled();
    expect((await entries(fileId)).map((r) => r.imageId)).toEqual([null]);
    expect(await fileRow(fileId)).toMatchObject({ unpackedAt: null, processingAt: null });
    // The next run carries on from the rows already there.
    expect(await unpack.unpackFinals()).toBe(1);
    expect(images.createImage).toHaveBeenCalledTimes(1);
  });

  it('marks a file with no images unpacked, with no entries', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.txt', data: Buffer.from('plain text here!!') },
    ]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await entries(fileId)).toEqual([]);
    expect((await fileRow(fileId)).unpackedAt).not.toBeNull();
    expect(images.createImage).not.toHaveBeenCalled();
  });

  it('judges a Final that is itself an image as one entry, and a model file as none', async () => {
    const dealId = await accepted();
    const image = await final(dealId, 'cover.png', IMAGE_A);
    const model = await final(dealId, 'm.safetensors', Buffer.from('weights weights weights'));
    s3.send.mockImplementation(async (command: { input: { Key: string } }) =>
      body(bucket.objects.get(command.input.Key)!)
    );
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await entries(image)).map((r) => [r.entryIndex, r.path])).toEqual([[0, 'cover.png']]);
    expect(preview.entryCopy.mock.calls[0][0].equals(IMAGE_A)).toBe(true);
    expect(await entries(model)).toEqual([]);
    expect(bucket.zipReads).toEqual([]); // neither is read as an archive
    expect((await fileRow(model)).unpackedAt).not.toBeNull();
  });

  it('refuses a top-level image over the image size cap at upload', async () => {
    const dealId = await accepted();
    await expect(
      files.requestServiceDealUpload({
        dealId,
        userId: SELLER,
        kind: 'Final',
        fileName: 'huge.PNG',
        mimeType: 'image/png',
        size: SERVICE_ZIP_MAX_IMAGE_BYTES + 1,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toEqual([]);
  });

  it('fails a top-level image the converter cannot read, and does not let it pass as a document', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'cover.png', Buffer.from('this is plainly not a png'));
    preview.entryCopy.mockRejectedValueOnce(new PreviewRejectedError('broken'));
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await entries(fileId))[0]).toMatchObject({ entryIndex: 0, scanStatus: 'Failed' });
  });

  it('refuses a top-level image over the cap again before reading it', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'huge.png', IMAGE_A);
    await q(`UPDATE "ServiceDealFile" SET size = $2 WHERE id = $1`, [
      fileId,
      SERVICE_ZIP_MAX_IMAGE_BYTES + 1,
    ]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: 'That image is too large to deliver.',
    });
    expect(images.createImage).not.toHaveBeenCalled();
  });
});

describe('what stops an archive', () => {
  const bigEntries = (n: number): FixtureEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `f${i}.txt`,
      data: Buffer.from('x'),
      method: 'store' as const,
    }));

  const cases: [string, () => FixtureEntry[], RegExp][] = [
    ['an encrypted entry', () => [{ name: 'a.txt', data: Buffer.from('x'), flags: 1 }], /Password/],
    [
      'a nested archive',
      () => [{ name: 'inner.zip', data: Buffer.from('not really a zip') }],
      /nested/,
    ],
    [
      'a path out of the archive',
      () => [{ name: '../evil.png', data: IMAGE_A }],
      /outside the archive/,
    ],
    [
      'a symbolic link',
      () => [{ name: 'l', data: Buffer.from('/etc'), externalAttributes: symlinkAttributes() }],
      /symbolic links/,
    ],
    [
      'a model file inside',
      () => [{ name: 'weights.safetensors', data: Buffer.from('w') }],
      /Model files/,
    ],
    [
      'a video',
      () => [{ name: 'clip.mp4', data: MP4_BYTES() }],
      /^Video can't be delivered inside a \.zip\. Upload the video file directly\.$/,
    ],
    [
      'a video called something else',
      () => [{ name: 'a.dat', data: MP4_BYTES() }],
      /^Video can't be delivered inside a \.zip/,
    ],
    [
      'a transport stream behind an ID3 tag',
      () => [{ name: 'song.mp3', data: Buffer.concat([id3Tag(4000), tsStream(188)]) }],
      /Video/,
    ],
    [
      'an image behind an ID3 tag',
      () => [{ name: 'a.dat', data: Buffer.concat([id3Tag(20), IMAGE_A]) }],
      /not the image/,
    ],
    [
      `${SERVICE_ZIP_MAX_ENTRIES + 1} entries`,
      () => bigEntries(SERVICE_ZIP_MAX_ENTRIES + 1),
      /too many/,
    ],
    [
      'an entry bigger than it says',
      () => [
        {
          name: 'a.txt',
          data: Buffer.alloc(SERVICE_ZIP_MAX_ENTRY_BYTES + 1, 5),
          method: 'store',
          declaredSize: 100,
        },
      ],
      /too large/,
    ],
    [
      'a bomb whose header lies',
      () => [{ name: 'a.txt', data: Buffer.alloc(60 * 1024 * 1024), declaredSize: 500 }],
      /compressed beyond/,
    ],
    [
      'an image that is not an image',
      () => [{ name: 'a.png', data: Buffer.from('this is plainly not a png') }],
      /not the image/,
    ],
  ];

  it.each(cases)(
    'fails the file for %s, with the reason, and scans nothing',
    async (_n, make, reason) => {
      const dealId = await accepted();
      // A good image BEFORE the bad entry: nothing may be submitted for a refused archive.
      const fileId = await zipFinal(dealId, [{ name: 'good.png', data: IMAGE_A }, ...make()]);
      expect(await unpack.unpackFinals()).toBe(1);
      const file = await fileRow(fileId);
      expect(file.scanStatus).toBe('Failed');
      expect(file.failReason).toMatch(reason);
      expect(file.unpackedAt).not.toBeNull();
      expect(file.processingAt).toBeNull();
      expect(await entries(fileId)).toEqual([]);
      expect(images.createImage).not.toHaveBeenCalled();
      expect(preview.entryCopy).not.toHaveBeenCalled();
      // And it is not claimed again.
      expect(await unpack.unpackFinals()).toBe(0);
    }
  );

  it('holds a delivered deal for the moderators when its archive is refused', async () => {
    const dealId = await accepted();
    await zipFinal(dealId, [{ name: 'a.txt', data: Buffer.from('fine') }]);
    expect(await unpack.unpackFinals()).toBe(1);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    // Swap the contents for a refused archive after delivery, as a late finding would be.
    const [row] = await q<{ s3Key: string }>(`SELECT "s3Key" FROM "ServiceDealFile"`);
    bucket.objects.set(row.s3Key, buildZip([{ name: 'inner.zip', data: Buffer.from('x') }]));
    await q(`UPDATE "ServiceDealFile" SET "unpackedAt" = NULL`);
    await unpack.unpackFinals();
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
  });

  it('fails the file and keeps the rest of the archive unscanned when an image cannot be read', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.png', data: IMAGE_A },
      { name: 'b.png', data: IMAGE_B },
    ]);
    preview.entryCopy.mockRejectedValueOnce(new PreviewRejectedError('broken'));
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    const rows = await entries(fileId);
    expect(rows[0]).toMatchObject({ scanStatus: 'Failed', imageId: null });
    // The second image was never submitted.
    expect(images.createImage).not.toHaveBeenCalled();
  });
});

describe('judging a file by what it is', () => {
  const serveHeads = () =>
    s3.send.mockImplementation(async (command: { input: { Key: string; Range?: string } }) => {
      const whole = bucket.objects.get(command.input.Key)!;
      const range = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
      return body(range ? whole.subarray(Number(range[1]), Number(range[2]) + 1) : whole);
    });

  it.each([
    ['an image called notes.txt', 'notes.txt', PNG_BYTES()],
    ['an image called data.json', 'data.json', JPEG_BYTES()],
  ])('scans %s as an image', async (_n, name, content) => {
    const dealId = await accepted();
    const fileId = await final(dealId, name, content);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await entries(fileId)).map((r) => r.path)).toEqual([name]);
    expect(preview.entryCopy.mock.calls[0][0].equals(content)).toBe(true);
  });

  const PK = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.alloc(40)]);
  const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40)]);
  it.each([
    ['a video called notes.txt', MP4_BYTES(), /video file itself/],
    ['an archive called notes.txt', PK, /renamed/],
    ['a bitmap called notes.txt', BMP, /image format/],
  ])('refuses %s', async (_n, content, reason) => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'notes.txt', content);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await fileRow(fileId)).failReason).toMatch(reason);
    expect(await entries(fileId)).toEqual([]);
  });

  const JUNK = Buffer.from('a'.repeat(1024));
  /** A PDF as a writer makes one: a binary comment, then JPEG, deflated and plain streams. */
  const pdf = ({ start = '%PDF-1.7\n', end = 'trailer\n<< /Root 1 0 R >>\n%%EOF\n' } = {}) =>
    Buffer.concat([
      Buffer.from(start, 'latin1'),
      Buffer.from(
        '%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Subtype /Image /Filter /DCTDecode >>\nstream\n',
        'latin1'
      ),
      JPEG_BYTES(),
      Buffer.from('\nendstream\nendobj\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\n'),
      deflateSync(Buffer.from('BT /F1 12 Tf (hello) Tj ET '.repeat(80))),
      Buffer.from('\nendstream\nendobj\n3 0 obj\nstream\n'),
      Buffer.from('BT /F1 12 Tf 72 712 Td (a line of the brief) Tj ET\n'.repeat(50)),
      Buffer.from('endstream\nendobj\n'),
      Buffer.from(end, 'latin1'),
    ]);
  /** A PDF with no byte outside ASCII, which a text check alone would take as text. */
  const asciiPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
  );
  it.each([
    [
      'a PNG behind 1 KB of text, called notes.txt',
      'notes.txt',
      Buffer.concat([JUNK, PNG_BYTES()]),
    ],
    ['a zip behind 1 KB of text, called notes.txt', 'notes.txt', Buffer.concat([JUNK, PK])],
    ['a NUL byte in a .json', 'data.json', Buffer.from('{"a": 1}\u0000')],
    [
      'bytes that are not UTF-8, called notes.md',
      'notes.md',
      Buffer.from([0x68, 0x69, 0xc3, 0x28]),
    ],
  ])('refuses %s, which would be delivered unscanned', async (_n, name, content) => {
    const dealId = await accepted();
    const fileId = await final(dealId, name, content);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await fileRow(fileId)).failReason).toMatch(/doesn't look like a \.\w+ document/);
    expect(await entries(fileId)).toEqual([]);
  });

  it.each([
    ['a PNG behind 1 KB of text', Buffer.concat([JUNK, PNG_BYTES()])],
    ['a NUL byte', Buffer.from('fine\u0000')],
  ])('refuses a zip whose notes.txt holds %s', async (_n, data) => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.png', data: IMAGE_A },
      { name: 'docs/notes.txt', data },
    ]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: "A document in the archive isn't what its name says.",
    });
    expect(await entries(fileId)).toEqual([]);
  });

  // Deliverable policy: PDFs are not accepted. Uploads refuse a .pdf; a Final stored before that,
  // or a PDF under another name, stops here.
  it.each([
    ['a .pdf stored before uploads refused it', 'brief.pdf', pdf()],
    ['a PDF called notes.txt', 'notes.txt', asciiPdf],
    [
      'a PDF behind a line of text, called notes.txt',
      'notes.txt',
      Buffer.concat([Buffer.from('read me first\n'), asciiPdf]),
    ],
    ['a PDF header inside an ID3 tag, called song.mp3', 'song.mp3', pdfInId3()],
    ['a PDF called clip.mp4', 'clip.mp4', asciiPdf],
    ['a PDF called a.png', 'a.png', asciiPdf],
    [
      'a PDF header 1,000 bytes in, called notes.txt',
      'notes.txt',
      Buffer.concat([Buffer.from('a'.repeat(1000)), asciiPdf]),
    ],
  ])('refuses %s as a Final', async (_n, name, content) => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'notes.txt', content);
    await q(`UPDATE "ServiceDealFile" SET "fileName" = $2 WHERE id = $1`, [fileId, name]);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await fileRow(fileId)).failReason).toMatch(/PDF files can't be delivered/);
    expect(await entries(fileId)).toEqual([]);
  });

  // Deliverable policy: PDFs are not accepted, inside a .zip either.
  it.each([
    ['a PDF called brief.pdf', 'brief.pdf', pdf()],
    ['a PDF called docs/notes.txt', 'docs/notes.txt', asciiPdf],
    ['a brief.pdf that holds plain text', 'brief.pdf', Buffer.from('plain words')],
    ['a PDF header inside the ID3 tag of song.mp3', 'song.mp3', pdfInId3()],
  ])('refuses a zip holding %s', async (_n, name, data) => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.png', data: IMAGE_A },
      { name, data },
    ]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await fileRow(fileId)).failReason).toMatch(/PDF files can't be delivered/);
    expect(await entries(fileId)).toEqual([]);
  });

  it('unpacks a zip whose documents are what their names say', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.png', data: IMAGE_A },
      { name: 'docs/notes.txt', data: Buffer.from('Résumé — notes ✓\n'.repeat(100)) },
      // Inflated 16 KB at a time, so the ✓ arrives split across two chunks.
      { name: 'docs/long.txt', data: Buffer.from(`${'a'.repeat(16383)}✓`) },
    ]);
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(fileId)).failReason).toBeNull();
    expect((await entries(fileId)).map((e) => e.path)).toEqual(['a.png']);
  });

  it.each([
    ['a UTF-8 .txt', 'notes.txt', Buffer.from('Résumé — notes, ✓ done\n'.repeat(200))],
    // A reader looks for the header in the first 1 KB only.
    [
      'a .txt whose "%PDF-" starts just past 1 KB',
      'notes.txt',
      Buffer.from(`${'a'.repeat(1025)}%PDF-1.7`),
    ],
    [
      'a .md that quotes "%PDF-" after 1 KB',
      'notes.md',
      Buffer.from(`${'# Notes\n'.repeat(200)}A PDF starts with \`%PDF-\`.\n`),
    ],
    [
      'a .json that quotes "%PDF-" after 1 KB',
      'data.json',
      Buffer.from(JSON.stringify({ pad: 'a'.repeat(1100), magic: '%PDF-1.7' })),
    ],
  ])('delivers %s', async (_n, name, content) => {
    const dealId = await accepted();
    const fileId = await final(dealId, name, content);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(fileId)).failReason).toBeNull();
    expect((await fileRow(fileId)).unpackedAt).not.toBeNull();
  });

  it('leaves plain documents without entries, and takes a model file that is a zip', async () => {
    const dealId = await accepted();
    const doc = await final(dealId, 'brief.txt', Buffer.from('just some words in a text file'));
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await entries(doc)).toEqual([]);
    expect((await fileRow(doc)).unpackedAt).not.toBeNull();
    // A checkpoint saved by torch is a zip in torch's layout; it is taken without being unpacked.
    const torch = buildZip([
      { name: 'weights/data.pkl', data: Buffer.from([0x80, 0x02, 0x7d, 0x2e]) },
      { name: 'weights/data/0', data: Buffer.alloc(64) },
      { name: 'weights/version', data: Buffer.from('3\n') },
    ]);
    const model = await final(dealId, 'm.pt', torch);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await fileRow(model)).toMatchObject({ scanStatus: 'Pending', failReason: null });
    expect(await entries(model)).toEqual([]);
  });
});

describe('video by any other name', () => {
  const serveHeads = () =>
    s3.send.mockImplementation(async (command: { input: { Key: string; Range?: string } }) => {
      const whole = bucket.objects.get(command.input.Key)!;
      const range = /^bytes=(\d+)-(\d+)$/.exec(command.input.Range ?? '');
      return body(range ? whole.subarray(Number(range[1]), Number(range[2]) + 1) : whole);
    });
  /** One Ogg page opening (beginning-of-stream) a stream whose first packet is `packet`. */
  const oggPage = (packet: Buffer, beginning = true) =>
    Buffer.concat([
      Buffer.from('OggS', 'latin1'),
      Buffer.from([0, beginning ? 0x02 : 0]),
      Buffer.alloc(20),
      Buffer.from([1, packet.length]),
      packet,
    ]);
  const vorbis = oggPage(Buffer.concat([Buffer.from('\x01vorbis', 'latin1'), Buffer.alloc(22)]));
  const theora = oggPage(Buffer.concat([Buffer.from('\x80theora', 'latin1'), Buffer.alloc(34)]));
  const comments = oggPage(Buffer.alloc(40), false);
  const tsPackets = (prefix = 0) =>
    Buffer.concat(
      [0, 1, 2, 3].map(() =>
        Buffer.concat([Buffer.alloc(prefix), Buffer.from([0x47]), Buffer.alloc(187)])
      )
    );
  const VIDEOS: [string, Buffer][] = [
    ['an mp4', MP4_BYTES()],
    ['a webm', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40)])],
    ['an avi', Buffer.concat([Buffer.from('RIFF\0\0\0\0AVI ', 'latin1'), Buffer.alloc(40)])],
    ['an Ogg Theora', Buffer.concat([theora, comments])],
    ['an Ogg with sound then Theora', Buffer.concat([vorbis, theora, comments])],
    ['an MPEG-TS stream', tsPackets()],
    ['an M2TS stream', tsPackets(4)],
    [
      'an MPEG-TS stream after 37 bytes of junk',
      Buffer.concat([Buffer.alloc(37, 0x11), tsPackets()]),
    ],
    ['an MPEG-TS stream of 204-byte packets', tsStream(204)],
    ['an MPEG-TS stream behind an ID3 tag', Buffer.concat([id3Tag(300), tsPackets()])],
    [
      'an MPEG-TS stream behind ID3 tags longer than one read',
      Buffer.concat([id3Tag(100_000), id3Tag(10), tsPackets()]),
    ],
    ['nine ID3 tags', Buffer.concat([...Array(9).fill(id3Tag(10)), MP3_FRAME()])],
  ];
  const refused = async (name: string, content: Buffer) => {
    const dealId = await accepted();
    const fileId = await final(dealId, name, content);
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    return fileRow(fileId);
  };

  it.each(
    [
      'weights.safetensors',
      'weights.ckpt',
      'weights.pt',
      'weights.pth',
      'weights.gguf',
      'weights.onnx',
    ].flatMap((name) => VIDEOS.map(([kind, content]) => [name, kind, content] as const))
  )('refuses %s holding %s', async (name, _kind, content) => {
    expect(await refused(name, content)).toMatchObject({
      scanStatus: 'Failed',
      failReason: expect.stringMatching(/[Vv]ideo/),
    });
  });

  it.each([
    ['clip.ogg', Buffer.concat([theora, comments])],
    ['song.mp3', tsPackets()],
    ['song.mp3', Buffer.concat([id3Tag(300), tsPackets()])],
    ['notes.txt', Buffer.concat([id3Tag(300), tsPackets()])],
    // The second stream opens 4 KiB in, past what one small read would see.
    ['song.ogg', Buffer.concat([vorbis, ...Array(100).fill(comments), theora])],
  ])('refuses %s, which is video', async (name, content) => {
    expect((await refused(name, content)).failReason).toMatch(/[Vv]ideo/);
  });

  const ogg = (...pages: Buffer[]) => Buffer.concat(pages);
  it.each<[string, Buffer, RegExp]>([
    ['weights.pt', buildZip([{ name: 'clip.mp4', data: MP4_BYTES() }]), /\.pt model/],
    [
      'weights.pt',
      Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(600)]),
      /\.pt model/,
    ],
    [
      'weights.safetensors',
      Buffer.concat([
        Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]),
        Buffer.alloc(600),
      ]),
      /\.safetensors model/,
    ],
    [
      'weights.gguf',
      Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), Buffer.alloc(600)]),
      /\.gguf model/,
    ],
    [
      'weights.onnx',
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x20]),
        Buffer.from('moov', 'latin1'),
        Buffer.alloc(600),
      ]),
      /\.onnx model/,
    ],
    [
      'song.mp3',
      Buffer.concat([Buffer.from([0x30, 0x26, 0xb2, 0x75]), Buffer.alloc(600)]),
      /\.mp3 audio/,
    ],
    ['song.ogg', ogg(vorbis, comments, theora), /[Vv]ideo/],
    ['song.ogg', ogg(vorbis, Buffer.from([0]), theora), /[Vv]ideo/],
    ['song.mp3', Buffer.concat([id3Tag(300), Buffer.alloc(600)]), /\.mp3 audio/],
    ['weights.pt', torchZip([['clip.mp4', MP4_BYTES()]]), /\.pt model/],
    ['weights.pt', torchZip([], 'a', [['b/data.pkl', PICKLE()]]), /\.pt model/],
    ['weights.pt', torchZip([['.data/clip.mp4', Buffer.alloc(8)]]), /\.pt model/],
    ['weights.pt', torchZip([['code/clip.mp4', Buffer.alloc(8)]]), /\.pt model/],
    ['weights.pt', torchZip([['data/0', MP4_BYTES()]]), /\.pt model/],
    ['weights.pt', torchZip([['data/0', MP4_BYTES(), 'deflate']]), /\.pt model/],
    [
      'weights.pth',
      // Past the first KiB, so only reading the entry finds it.
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        ['extra/notes', tsStream(188)],
      ]),
      /\.pth model/,
    ],
    [
      'weights.ckpt',
      torchZip([['data/1', Buffer.concat([id3Tag(20), MP4_BYTES()])]]),
      /\.ckpt model/,
    ],
    ['weights.ckpt', torchZip([['data/1', pdfInId3(), 'deflate']]), /PDF files can't be delivered/],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(64)]], 'weights', [], {
        'weights/data/0': { localName: 'weights/clip.mp4' },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { localMethod: 8 },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { localFlags: 0x800 },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': {
          localExtra: Buffer.concat([
            Buffer.from([0x75, 0x70, 5, 0, 1, 0, 0, 0, 0]),
            Buffer.from('x'),
          ]),
        },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': {
          centralExtra: Buffer.concat([
            Buffer.from([0x75, 0x70, 5, 0, 1, 0, 0, 0, 0]),
            Buffer.from('x'),
          ]),
        },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { after: MP4_BYTES() },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/version': { after: MP4_BYTES() },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/version': { after: Buffer.alloc(16) },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { descriptor: false, localCompressedSize: 10 },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { localCompressedSize: 10 },
      }),
      /described differently/,
    ],
    ...[
      descriptor(0, 4096, 4096),
      descriptor(crc32(Buffer.alloc(4096, 3)), 10, 4096),
      descriptor(crc32(Buffer.alloc(4096, 3)), 4096, 10),
    ].map((wrong): [string, Buffer, RegExp] => [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { descriptor: wrong },
      }),
      /described differently/,
    ]),
    // Inflated in full, so held to the limits an unpacked archive's entries are.
    [
      'weights.pt',
      torchZip(
        [['code/__torch__/big.py', Buffer.alloc(8 * 1024 * 1024), 'deflate']],
        'weights',
        [],
        { 'weights/code/__torch__/big.py': { descriptor: true } }
      ),
      /compressed beyond/,
    ],
    // Delivered without its images scanned, so it may hold none.
    ...[
      ['extra/cover.png', PNG_BYTES()],
      ['extra/cover', JPEG_BYTES()],
      ['extra/scan.tif', Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(40)])],
      ['data/1', PNG_BYTES()],
      ['data/1', Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(40)])],
      ['extra/cover.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['extra/cover.jxl', Buffer.from([0xff, 0x0a, 0, 0, 0, 0])],
      ['extra/clip.mp4', Buffer.alloc(64)],
      ['extra/x', Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(40)])],
      ['extra/x', Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(40)])],
    ].map(([path, bytes]): [string, Buffer, RegExp] => [
      'weights.pt',
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        [path as string, bytes as Buffer],
      ]),
      /\.pt model/,
    ]),
    // A deflate stream that ends before the data the directory gives it.
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3), 'deflate']], 'weights', [], {
        'weights/data/0': { descriptor: true, compressedTail: Buffer.from('PK') },
      }),
      /described differently/,
    ],
    [
      'weights.pt',
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        ['extra/notes', Buffer.concat([Buffer.alloc(100, 3), tsStream(188)])],
      ]),
      /\.pt model/,
    ],
    ...[tsStream(188), tsPackets(4)].map((stream): [string, Buffer, RegExp] => [
      'weights.pt',
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        ['data/1', stream],
      ]),
      /\.pt model/,
    ]),
    [
      'weights.pt',
      torchZip([['data/0', Buffer.alloc(4096, 3)]], 'weights', [], {
        'weights/data/0': { flags: 1 },
      }),
      /Password/,
    ],
  ])('refuses %s that is not that format', async (name, content, reason) => {
    expect((await refused(name, content)).failReason).toMatch(reason);
  });

  it('counts each refusal by the type it claimed, and nothing else', async () => {
    loggingMock.logToAxiom.mockClear();
    await refused('weights.gguf', Buffer.alloc(600, 1));
    const calls = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { message?: string }).message === 'final is not its claimed format'
    );
    expect(calls).toEqual([
      [expect.objectContaining({ payload: { kind: 'model', extension: 'gguf' } })],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/fileId|dealId|weights/);
  });

  it('refuses a picture named as a model file', async () => {
    expect((await refused('weights.safetensors', PNG_BYTES())).failReason).toBe(
      "This file doesn't look like a .safetensors model file."
    );
  });

  const safetensors = () => {
    const header = Buffer.from('{"w":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}', 'latin1');
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(header.length));
    return Buffer.concat([size, header, Buffer.alloc(600)]);
  };
  const gguf = () =>
    Buffer.concat([Buffer.from('GGUF', 'latin1'), Buffer.from([3, 0, 0, 0]), Buffer.alloc(600)]);
  /** A safetensors file whose 64 KiB header length starts like an icon (00 00 01 00). */
  const iconLike = () => {
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(65536));
    return Buffer.concat([size, Buffer.from('{"w":{}}', 'latin1'), Buffer.alloc(600)]);
  };
  /** Sync bytes at the first two packet starts only: not a transport stream. */
  const twoSyncs = () => {
    const bytes = Buffer.alloc(600, 0x11);
    bytes[0] = 0x47;
    bytes[188] = 0x47;
    return bytes;
  };
  /** Three packets of a transport stream: one short of what is taken as one. No NUL byte, so a
   * .txt holding it is still text. */
  const threeSyncs = () => {
    const bytes = Buffer.alloc(3 * 188 + 600, 0x11);
    for (const at of [0, 188, 376]) bytes[at] = 0x47;
    return bytes;
  };
  /** Sync bytes every `gap` bytes, a spacing no transport stream uses. */
  const spacedSyncs = (gap: number) => {
    const bytes = Buffer.alloc(1200, 0x11);
    for (let at = 0; at < bytes.length; at += gap) bytes[at] = 0x47;
    return bytes;
  };
  it.each([
    ['weights.safetensors', iconLike()],
    ['notes.txt', twoSyncs()],
    ['weights.safetensors', safetensors()],
    ['weights.gguf', gguf()],
    ['weights.pt', Buffer.concat([Buffer.from([0x80, 0x02, 0x7d, 0x71, 0x00]), Buffer.alloc(600)])],
    [
      'weights.onnx',
      Buffer.concat([
        Buffer.from([0x08, 0x07, 0x12, 0x07]),
        Buffer.from('pytorch'),
        Buffer.alloc(600),
      ]),
    ],
    ['song.mp3', MP3_FRAME()],
    ['song.mp3', Buffer.concat([id3Tag(300), MP3_FRAME()])],
    ['song.mp3', Buffer.concat([id3Tag(100_000), MP3_FRAME()])],
    ['song.mp3', Buffer.concat([id3Tag(300, true), MP3_FRAME()])],
    ['song.mp3', Buffer.concat([...Array(8).fill(id3Tag(10)), MP3_FRAME()])],
    ['notes.txt', threeSyncs()],
    ['song.mp3', Buffer.concat([MP3_FRAME(), spacedSyncs(100)])],
    ['weights.pth', torchZip([['data/0', Buffer.alloc(64, 3), 'deflate']])],
    // torch.jit.save deflates its code and debug pickles, each with a data descriptor.
    [
      'weights.pt',
      torchZip(
        [
          [
            'code/__torch__/model.py',
            Buffer.from('class Model(Module):\n  pass\n'.repeat(40)),
            'deflate',
          ],
          [
            'code/__torch__/model.py.debug_pkl',
            Buffer.concat([PICKLE(), Buffer.alloc(900)]),
            'deflate',
          ],
        ],
        'weights',
        [],
        {
          'weights/code/__torch__/model.py': { descriptor: true },
          'weights/code/__torch__/model.py.debug_pkl': { descriptor: true },
        }
      ),
    ],
    // Tensor bytes are opaque: a stream is looked for only where a file of one would start.
    [
      'weights.pt',
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        ['data/1', Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(4096)])],
      ]),
    ],
    [
      'weights.pt',
      torchZip([
        ['constants.pkl', PICKLE()],
        ['constants/0', Buffer.concat([Buffer.from([0, 0, 1, 0]), Buffer.alloc(4096)])],
      ]),
    ],
    [
      'weights.pt',
      torchZip([
        ['data/0', Buffer.alloc(4096, 3)],
        ['data/1', Buffer.concat([Buffer.alloc(100, 3), tsStream(188)])],
      ]),
    ],
    ['song.wav', Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(600)])],
    ['song.wav', Buffer.concat([Buffer.from('RF64\0\0\0\0WAVEds64', 'latin1'), Buffer.alloc(600)])],
    ['song.flac', Buffer.concat([Buffer.from('fLaC', 'latin1'), Buffer.alloc(600)])],
    ['song.flac', Buffer.concat([id3Tag(300), Buffer.from('fLaC', 'latin1'), Buffer.alloc(600)])],
    ['weights.ckpt', Buffer.concat([PICKLE(), Buffer.alloc(600)])],
    ['weights.pth', Buffer.concat([PICKLE(), Buffer.alloc(600)])],
    ['weights.pth', torchZip([['data/0', Buffer.alloc(64, 3)]])],
    [
      'weights.ckpt',
      torchZip([
        ['data/0', Buffer.alloc(64, 3)],
        ['.data/serialization_id', Buffer.from('1')],
      ]),
    ],
    [
      'weights.pt',
      torchZip([
        ['constants.pkl', PICKLE()],
        ['attributes.pkl', PICKLE()],
        ['code/__torch__/model.py', Buffer.from('class Model(Module):\n  pass\n')],
        ['code/__torch__/model.py.debug_pkl', PICKLE()],
        ['.data/version', Buffer.from('3\n')],
        ['extra/notes.txt', Buffer.from('trained on 4 GPUs')],
      ]),
    ],
    ['song.ogg', Buffer.concat([vorbis, comments])],
  ])('takes %s as it is', async (name, content) => {
    expect(await refused(name, content)).toMatchObject({ scanStatus: 'Pending', failReason: null });
  });
});

describe('a file that keeps failing', () => {
  it('does not hold up the files behind it', async () => {
    const dealId = await accepted();
    const bad = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    const good = await zipFinal(dealId, [
      { name: 'b.txt', data: Buffer.from('plain text here!!') },
    ]);
    const badKey = (await fileRow(bad)).s3Key;
    bucket.objects.delete(badKey); // reading it throws, which is not the file's fault
    expect(await unpack.unpackFinals()).toBe(0);
    expect((await fileRow(bad)).unpackedAt).toBeNull();
    // The next run takes the other file, not the same one again.
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(good)).unpackedAt).not.toBeNull();
    // And the failing one is tried again once its delay has passed.
    await ageClaim(bad, SERVICE_UNPACK_STALE_MS + 60_000);
    bucket.objects.set(badKey, buildZip([{ name: 'a.png', data: IMAGE_A }]));
    expect(await unpack.unpackFinals()).toBe(1);
    expect((await fileRow(bad)).unpackedAt).not.toBeNull();
  });
});

describe('delivery waits for the unpack', () => {
  it('will not deliver a round whose Final has not been unpacked, and will once it has', async () => {
    const dealId = await accepted();
    await zipFinal(dealId, [{ name: 'a.txt', data: Buffer.from('plain text here!!') }]);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await unpack.unpackFinals()).toBe(1);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).resolves.toBeTruthy();
  });

  it('shows the seller a refusal before delivery and lets them replace the file', async () => {
    const dealId = await accepted();
    const bad = await zipFinal(dealId, [{ name: 'c.mp4', data: MP4_BYTES() }]);
    await unpack.unpackFinals();
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await dealStatus(dealId)).status).toBe('Accepted'); // not held: nothing was delivered
    await files.deleteServiceDealFile({ fileId: bad, userId: SELLER });
    await zipFinal(dealId, [{ name: 'a.txt', data: Buffer.from('plain text here!!') }]);
    await unpack.unpackFinals();
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).resolves.toBeTruthy();
  });
});

describe('resuming', () => {
  it('does not ingest an image twice after a run dies part-way', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'a.png', data: IMAGE_A },
      { name: 'b.png', data: IMAGE_B },
    ]);
    // The second image's Image row cannot be created: the run dies after uploading its copy.
    images.createImage
      .mockImplementationOnce(async ({ url }: { url: string }) => {
        const [row] = await q<{ id: number }>(
          `INSERT INTO "Image" (url) VALUES ($1) RETURNING id`,
          [url]
        );
        return { id: row.id };
      })
      .mockRejectedValueOnce(new Error('connection reset'));
    expect(await unpack.unpackFinals()).toBe(0);

    let rows = await entries(fileId);
    expect(rows[0].imageId).not.toBeNull();
    // The key was recorded before the row was attempted.
    expect(rows[1]).toMatchObject({ imageId: null, scanKey: 'scan-key-2' });
    const file = await fileRow(fileId);
    expect(file).toMatchObject({ unpackedAt: null, scanStatus: 'Pending' });

    // It is tried again after the retry delay, not at once.
    expect(await unpack.unpackFinals()).toBe(0);
    await ageClaim(fileId, SERVICE_UNPACK_STALE_MS + 60_000);

    // The next run finishes: the first image is not ingested again, the second reuses its object.
    expect(await unpack.unpackFinals()).toBe(1);
    rows = await entries(fileId);
    expect(rows.every((r) => r.imageId !== null)).toBe(true);
    expect(s3.uploadImageBufferToStore).toHaveBeenCalledTimes(2);
    expect(images.createImage).toHaveBeenCalledTimes(3);
    expect((await q(`SELECT 1 FROM "Image"`)).length).toBe(2);
  });

  it('finds the Image row a crash left behind instead of creating a second', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    // A previous run created the row and died before recording it.
    await q(
      `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size", "scanKey") VALUES ($1, 1, 0, 'a.png', 1, 'left-key')`,
      [fileId]
    );
    await q(`INSERT INTO "Image" (url) VALUES ('left-key')`);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(images.createImage).not.toHaveBeenCalled();
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
    expect((await entries(fileId))[0].imageId).toBe(1);
  });

  it('never takes a posted image with the same key for the row a crash left', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await q(
      `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size", "scanKey") VALUES ($1, 1, 0, 'a.png', 1, 'left-key')`,
      [fileId]
    );
    await q(`INSERT INTO "Image" (url, "postId") VALUES ('left-key', 5), ('left-key', NULL)`);
    expect(await unpack.unpackFinals()).toBe(1);
    expect(images.createImage).not.toHaveBeenCalled();
    expect((await entries(fileId))[0].imageId).toBe(2);
  });

  it('does not submit an image that was already judged and whose copy is gone', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await q(
      `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size", "scanStatus") VALUES ($1, 1, 0, 'a.png', 1, 'Passed')`,
      [fileId]
    );
    expect(await unpack.unpackFinals()).toBe(1);
    expect(images.createImage).not.toHaveBeenCalled();
    expect((await fileRow(fileId)).unpackedAt).not.toBeNull();
  });

  it('keeps the copy it just made when the file was deleted underneath it, as an orphan to judge', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    images.createImage.mockImplementationOnce(async ({ url }: { url: string }) => {
      const [row] = await q<{ id: number }>(`INSERT INTO "Image" (url) VALUES ($1) RETURNING id`, [
        url,
      ]);
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      return { id: row.id };
    });
    await unpack.unpackFinals();
    // Its scan has not finished, so nothing is deleted.
    expect(images.deleteImages).not.toHaveBeenCalled();
    const rows = await q<{
      fileId: number | null;
      dealId: number;
      imageId: number;
      scanKey: string;
    }>(`SELECT "fileId", "dealId", "imageId", "scanKey" FROM "ServiceDealFileEntry"`);
    expect(rows).toEqual([{ fileId, dealId, imageId: 1, scanKey: 'scan-key-1' }]);
    expect((await fileRow(fileId)).removedAt).not.toBeNull();
    // And the verdict, when it comes, is taken like any other.
    await q(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 1`);
    await unpack.settleEntryScans();
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
    expect(await q(`SELECT id FROM "Image"`)).toEqual([{ id: 1 }]);
  });
});

describe('the verdict on each image', () => {
  async function submitted(count = 1) {
    const dealId = await accepted();
    const fileId = await zipFinal(
      dealId,
      Array.from({ length: count }, (_, i) => ({ name: `i${i}.png`, data: IMAGE_A }))
    );
    await unpack.unpackFinals();
    return { dealId, fileId };
  }

  it.each([
    ['clean, PG', 'Scanned', '', 1],
    ['clean, PG-13', 'Scanned', '', 2],
  ])('passes an image that is %s, and records its rating', async (_n, ingestion, flags, level) => {
    const { fileId } = await submitted();
    await verdict(ingestion, flags, level);
    expect(await unpack.settleEntryScans()).toMatchObject({ passed: 1, rejected: 0 });
    expect((await entries(fileId))[0]).toMatchObject({ scanStatus: 'Passed', nsfwLevel: level });
  });

  it.each([
    ['unrated', 'Scanned', '', 0],
    ['sent to review', 'Scanned', `, "needsReview" = 'minor'`, 1],
    ['flagged as a real person', 'Scanned', ', poi = true', 1],
    ['flagged as a minor', 'Scanned', ', minor = true', 1],
    ['blocked', 'Blocked', '', 1],
  ])('fails an image that is %s, keeping its rating', async (_n, ingestion, flags, level) => {
    const { fileId } = await submitted();
    await verdict(ingestion, flags, level);
    expect(await unpack.settleEntryScans()).toMatchObject({ passed: 0, rejected: 1 });
    expect((await entries(fileId))[0]).toMatchObject({
      scanStatus: 'Failed',
      nsfwLevel: level,
      failReason: expect.stringContaining('rejected'),
    });
  });

  it.each([4, 16])(
    "fails an image rated %i, above the deal's level, saying only that",
    async (level) => {
      const { fileId } = await submitted();
      await verdict('Scanned', '', level);
      expect(await unpack.settleEntryScans()).toMatchObject({ passed: 0, rejected: 1 });
      expect((await entries(fileId))[0]).toMatchObject({
        scanStatus: 'Failed',
        nsfwLevel: level,
        failReason: SERVICE_FINAL_OVER_LEVEL_REASON,
      });
      expect((await fileRow(fileId)).failReason).toBe(SERVICE_FINAL_OVER_LEVEL_REASON);
    }
  );

  it('rejects an image rated above every level a deal can have', async () => {
    const { fileId } = await submitted();
    await verdict('Scanned', '', 32);
    await unpack.settleEntryScans();
    expect((await entries(fileId))[0].failReason).toMatch(/rejected/);
  });

  it('fails an image the scan could not run on, without calling it rejected', async () => {
    const { fileId } = await submitted();
    await verdict('NotFound');
    expect(await unpack.settleEntryScans()).toMatchObject({ passed: 0, rejected: 0, unchecked: 1 });
    expect((await entries(fileId))[0]).toMatchObject({
      scanStatus: 'Failed',
      failReason: expect.stringContaining('could not be checked'),
    });
  });

  it('leaves an image still being scanned alone, and gives up on one that never settles', async () => {
    const { fileId } = await submitted();
    expect(await unpack.settleEntryScans()).toEqual({
      passed: 0,
      rejected: 0,
      unchecked: 0,
      timedOut: 0,
    });
    expect((await entries(fileId))[0].scanStatus).toBe('Pending');
    await q(`UPDATE "ServiceDealFileEntry" SET "createdAt" = now() - interval '7 hours'`);
    expect((await unpack.settleEntryScans()).timedOut).toBe(1);
    expect((await entries(fileId))[0].scanStatus).toBe('Failed');
  });
});

describe('the rating limit', () => {
  it.each([
    [2, 2, 'Passed'],
    [2, 4, 'Failed'],
    [4, 4, 'Passed'],
    [4, 2, 'Passed'],
    [4, 8, 'Failed'],
    [16, 16, 'Passed'],
  ])('a deal limited to %i: an image rated %i is %s', async (limit, rating, expected) => {
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = $1`, [limit]);
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await unpack.unpackFinals();
    await verdict('Scanned', '', rating);
    await unpack.settleEntryScans();
    expect((await entries(fileId))[0]).toMatchObject({ scanStatus: expected, nsfwLevel: rating });
  });

  it('never passes an unrated image, whatever the limit', async () => {
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 16`);
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await unpack.unpackFinals();
    await verdict('Scanned', '', 0);
    await unpack.settleEntryScans();
    expect((await entries(fileId))[0].scanStatus).toBe('Failed');
  });
});

describe('the verdict on the whole Final', () => {
  async function unpacked(count: number, extras: FixtureEntry[] = []) {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      ...Array.from({ length: count }, (_, i) => ({ name: `i${i}.png`, data: IMAGE_A })),
      ...extras,
    ]);
    await unpack.unpackFinals();
    return { dealId, fileId };
  }
  const malwarePasses = (fileId: number) =>
    q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now() WHERE id = $1`,
      [fileId]
    );

  it('does NOT pass on its images alone: with no malware verdict it stays Pending', async () => {
    const { fileId } = await unpacked(2);
    await verdict('Scanned');
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect((await entries(fileId)).map((r) => r.scanStatus)).toEqual(['Passed', 'Passed']);
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
    // And submitting the malware scan cannot supply one: only a workflow's reading can.
    expect(
      await scan.submitFinalScan({ id: fileId, dealId: 1, s3Key: 'k', mimeType: 'x', size: 1 })
    ).toBe('Pending');
    expect((await fileRow(fileId)).malwareScanStatus).toBe('Pending');
  });

  it('passes when every image passed AND the malware scan passed', async () => {
    const { fileId } = await unpacked(2);
    await verdict('Scanned');
    await malwarePasses(fileId);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
  });

  it('does not pass while any one image is still being scanned', async () => {
    const { fileId } = await unpacked(2);
    await malwarePasses(fileId);
    await q(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 1`);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
    await q(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 2`);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
  });

  it('fails the whole Final when one image fails, and holds a delivered deal', async () => {
    const { dealId, fileId } = await unpacked(3);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await malwarePasses(fileId);
    await q(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id <> 2`);
    await q(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 2`);
    expect(await settle()).toEqual({ finalsFailed: 1, finalsPassed: 0 });
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: expect.stringContaining('rejected'),
    });
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
  });

  it('fails a Final whose malware scan failed, whatever its images did', async () => {
    const { fileId } = await unpacked(1);
    await verdict('Scanned');
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Failed' WHERE id = $1`, [fileId]);
    expect(await settle()).toEqual({ finalsFailed: 1, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Failed');
  });

  it('judges a Final with no images by the malware scan alone', async () => {
    const { fileId } = await unpacked(0, [
      { name: 'a.txt', data: Buffer.from('plain text here!!') },
    ]);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    await malwarePasses(fileId);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
  });

  it('does not pass a Final that has not been unpacked, even with a clean malware verdict', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await malwarePasses(fileId);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
  });
});

describe('the single verdict entry point', () => {
  async function ready() {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await unpack.unpackFinals();
    await q(
      `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed', "repackedAt" = now() WHERE id = $1`,
      [fileId]
    );
    await q(`UPDATE "ServiceDealFileEntry" SET "scanStatus" = 'Passed' WHERE "fileId" = $1`, [
      fileId,
    ]);
    return fileId;
  }
  const pass = (fileId: number) => files.recordFinalScanResult({ fileId, verdict: 'Passed' });

  it('takes a pass only when each part has passed: break one condition at a time', async () => {
    const fileId = await ready();
    const breaks: [string, string][] = [
      ['not unpacked', `UPDATE "ServiceDealFile" SET "unpackedAt" = NULL WHERE id = ${fileId}`],
      ['not repacked', `UPDATE "ServiceDealFile" SET "repackedAt" = NULL WHERE id = ${fileId}`],
      [
        'malware pending',
        `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Pending' WHERE id = ${fileId}`,
      ],
      [
        'malware failed',
        `UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Failed' WHERE id = ${fileId}`,
      ],
      [
        'an image pending',
        `UPDATE "ServiceDealFileEntry" SET "scanStatus" = 'Pending' WHERE "fileId" = ${fileId}`,
      ],
      [
        'an image failed',
        `UPDATE "ServiceDealFileEntry" SET "scanStatus" = 'Failed' WHERE "fileId" = ${fileId}`,
      ],
    ];
    for (const [label, breakIt] of breaks) {
      const snapshot = await fileRow(fileId);
      const entrySnapshot = await entries(fileId);
      await q(breakIt);
      expect(await pass(fileId), label).toEqual({ recorded: false, held: false });
      expect((await fileRow(fileId)).scanStatus, label).toBe('Pending');
      // Restore for the next condition.
      await q(
        `UPDATE "ServiceDealFile" SET "unpackedAt" = $2, "malwareScanStatus" = $3::"ServiceDealFileScanStatus", "repackedAt" = $4 WHERE id = $1`,
        [fileId, snapshot.unpackedAt, snapshot.malwareScanStatus, snapshot.repackedAt]
      );
      await q(
        `UPDATE "ServiceDealFileEntry" SET "scanStatus" = $2::"ServiceDealFileScanStatus" WHERE "fileId" = $1`,
        [fileId, entrySnapshot[0].scanStatus]
      );
    }
    // With every condition met it is taken.
    expect(await pass(fileId)).toEqual({ recorded: true, held: false });
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
  });

  it('refuses a pass for a file that was refused, whatever else is true of it', async () => {
    const fileId = await ready();
    await q(`UPDATE "ServiceDealFile" SET "failReason" = 'refused' WHERE id = $1`, [fileId]);
    expect(await pass(fileId)).toEqual({ recorded: false, held: false });
    // And the sweep finishes a refusal whose second write was lost.
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 1, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Failed');
  });

  it('takes a failure whatever state the parts are in', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    expect(await files.recordFinalScanResult({ fileId, verdict: 'Failed' })).toMatchObject({
      recorded: true,
    });
  });
});

describe('copies of scanned images', () => {
  async function settled() {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [
      { name: 'ok.png', data: IMAGE_A },
      { name: 'bad.png', data: IMAGE_B },
    ]);
    await unpack.unpackFinals();
    await q(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 1`);
    await q(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 2`);
    await unpack.settleEntryScans();
    return { dealId, fileId };
  }

  it('deletes the copy of a passed image and keeps the copy of a rejected one', async () => {
    const { fileId } = await settled();
    expect(await unpack.deleteEntryScanCopies()).toBe(1);
    const rows = await entries(fileId);
    expect(rows[0]).toMatchObject({ scanStatus: 'Passed', imageId: null, scanKey: null });
    expect(rows[1]).toMatchObject({ scanStatus: 'Failed', imageId: 2, scanKey: 'scan-key-2' });
    // The rejected image's row is still there for the moderators.
    expect(await q(`SELECT id FROM "Image"`)).toEqual([{ id: 2 }]);
    // And running it again deletes nothing more.
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
  });

  it('keeps a copy whose delete failed pointed at, and retries it', async () => {
    const { fileId } = await settled();
    images.deleteImages.mockRejectedValueOnce(new Error('store down'));
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
    expect((await entries(fileId))[0].imageId).toBe(1);
    expect(await unpack.deleteEntryScanCopies()).toBe(1);
  });

  it('keeps an entry pointed at a copy gone without this delete, and counts it hourly', async () => {
    const { fileId } = await settled();
    const hour = 60 * 60_000;
    const at = Date.now() + 1000 * hour;
    expect(await unpack.countDanglingScanCopies({ now: at })).toEqual({ settling: 0, dangling: 0 });
    await q(`DELETE FROM "Image" WHERE id = 1`);
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
    expect((await entries(fileId))[0]).toMatchObject({ imageId: 1, scanKey: 'scan-key-1' });
    expect(await unpack.countDanglingScanCopies({ now: at + hour - 1 })).toBeNull();
    expect(await unpack.countDanglingScanCopies({ now: at + hour })).toEqual({
      settling: 0,
      dangling: 1,
    });
  });

  it('counts a marked entry as dangling once its delete is past the settle window', async () => {
    const { fileId } = await settled();
    const at = Date.now() + 2000 * 60 * 60_000;
    await q(`DELETE FROM "Image" WHERE id = 1`);
    await q(`UPDATE "ServiceDealFileEntry" SET "copyDeleteStartedAt" = now() WHERE "fileId" = $1`, [
      fileId,
    ]);
    expect(await unpack.countDanglingScanCopies({ now: at })).toEqual({ settling: 1, dangling: 0 });
    await q(
      `UPDATE "ServiceDealFileEntry" SET "copyDeleteStartedAt" = now() - interval '31 minutes' WHERE "fileId" = $1`,
      [fileId]
    );
    expect(
      await unpack.countDanglingScanCopies({ now: at + 60 * 60_000 })
    ).toEqual({ settling: 0, dangling: 1 });
  });

  it('keeps the copy of an image still being scanned, however old and whatever becomes of its file', async () => {
    const dealId = await accepted();
    const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await unpack.unpackFinals();
    await files.recordFinalScanResult({ fileId, verdict: 'Failed' });
    await q(`UPDATE "ServiceDealFileEntry" SET "createdAt" = now() - interval '3 hours'`);
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
    expect((await entries(fileId))[0]).toMatchObject({
      scanStatus: 'Pending',
      scanKey: 'scan-key-1',
    });
    expect((await entries(fileId))[0].imageId).not.toBeNull();
  });

  describe('copies kept for their case', () => {
    /** 50 passed copies kept for their case, then one that can go. */
    async function keptThenDeletable() {
      const dealId = await accepted();
      await q(`INSERT INTO "Image" (url) SELECT 'kept' FROM generate_series(1, 50)`);
      await q(`INSERT INTO "Image" (url) VALUES ('free')`);
      await q(
        `INSERT INTO "ServiceDealFileEntry" ("dealId", "entryIndex", "path", "size", "imageId", "scanStatus")
           SELECT $1, i, 'a.png', 1, i, 'Passed' FROM generate_series(1, 51) i`,
        [dealId]
      );
      images.deleteImages.mockImplementation(async (ids: number[]) =>
        q(`DELETE FROM "Image" WHERE id = ANY($1::int[]) AND url <> 'kept' RETURNING id`, [ids])
      );
    }
    const copies = async () =>
      (await q<{ imageId: number }>(`SELECT "imageId" FROM "ServiceDealFileEntry"`)).map(
        (row) => row.imageId
      );

    it('do not hold up a copy after them: it goes in the same run or the next', async () => {
      await keptThenDeletable();
      const deleted =
        (await unpack.deleteEntryScanCopies()) + (await unpack.deleteEntryScanCopies());
      expect(deleted).toBe(1);
      expect(await copies()).not.toContain(51);
      expect(await copies()).toHaveLength(50);
    });

    it('are deleted once their case clears', async () => {
      await keptThenDeletable();
      await unpack.deleteEntryScanCopies();
      await unpack.deleteEntryScanCopies();
      await q(`UPDATE "Image" SET url = 'free'`);
      const deleted =
        (await unpack.deleteEntryScanCopies()) + (await unpack.deleteEntryScanCopies());
      expect(deleted).toBe(50);
      expect(await copies()).toEqual([]);
    });
  });

  describe('when the seller deletes a file whose passed image is gone', () => {
    async function removedFinal({ imageGoneFirst }: { imageGoneFirst: boolean }) {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      await unpack.unpackFinals();
      await q(`UPDATE "Image" SET ingestion = 'Scanned'`);
      await unpack.settleEntryScans();
      if (imageGoneFirst) await q(`DELETE FROM "Image"`);
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      return { dealId, fileId };
    }

    it('keeps the pointer, so the file is refused and kept, when the image went some other way', async () => {
      const { dealId, fileId } = await removedFinal({ imageGoneFirst: true });
      expect((await entries(fileId))[0].imageId).not.toBeNull();
      expect(await callerSees(dealId, fileId, DISPUTE_TOOL)).toEqual({
        listed: false,
        downloaded: false,
      });
      await q(`UPDATE "ServiceDealFile" SET "removedAt" = now() - interval '1 day'`);
      expect(await files.purgeRemovedFiles()).toBe(0);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).toHaveLength(1);
    });

    it('lets go of a copy its own delete removed', async () => {
      const { dealId, fileId } = await removedFinal({ imageGoneFirst: false });
      expect((await entries(fileId))[0].imageId).toBeNull();
      expect(await callerSees(dealId, fileId, DISPUTE_TOOL)).toEqual({
        listed: true,
        downloaded: true,
      });
    });
  });

  describe('when the seller deletes the file', () => {
    async function threeImages() {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [
        { name: 'ok.png', data: IMAGE_A },
        { name: 'bad.png', data: IMAGE_B },
        { name: 'slow.png', data: IMAGE_A },
      ]);
      await unpack.unpackFinals();
      await q(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 1`);
      await q(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 2`);
      // The third is still being scanned.
      await unpack.settleEntryScans();
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      return { dealId, fileId };
    }
    const orphans = () =>
      q<EntryRecord & { dealId: number }>(
        `SELECT * FROM "ServiceDealFileEntry" ORDER BY "entryIndex"`
      );

    it('removes the copy of a passed image only: a rejected one and one still being scanned stay', async () => {
      const { fileId } = await threeImages();
      expect(images.deleteImages).toHaveBeenCalledTimes(1);
      expect(images.deleteImages).toHaveBeenCalledWith([1], {
        updatePosts: false,
        actor: { system: 'creator-service-deal-file' },
      });
      expect(await q(`SELECT id FROM "Image" ORDER BY id`)).toEqual([{ id: 2 }, { id: 3 }]);
      const rows = await orphans();
      expect(rows.map((r) => [r.scanStatus, r.imageId, r.fileId, r.dealId])).toEqual([
        ['Passed', null, fileId, 1],
        ['Failed', 2, fileId, 1],
        ['Pending', 3, fileId, 1],
      ]);
    });

    it('keeps the rows of images not submitted yet, and holds the file', async () => {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      await q(
        `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size") VALUES ($1, $2, 0, 'a.png', 1)`,
        [fileId, dealId]
      );
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      expect(await q(`SELECT "fileId", "imageId" FROM "ServiceDealFileEntry"`)).toEqual([
        { fileId, imageId: null },
      ]);
      expect((await fileRow(fileId)).removedAt).not.toBeNull();
    });

    it("leaves another file's entries alone, even one pointing at a copy that is gone", async () => {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      const other = await zipFinal(dealId, [{ name: 'b.png', data: IMAGE_B }]);
      await q(
        `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size", "imageId", "scanKey") VALUES ($1, $2, 0, 'b.png', 1, 999, 'gone-key')`,
        [other, dealId]
      );
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      expect(
        await q(`SELECT "imageId", "scanKey" FROM "ServiceDealFileEntry" WHERE "fileId" = $1`, [
          other,
        ])
      ).toEqual([{ imageId: 999, scanKey: 'gone-key' }]);
    });

    it('still judges the image whose scan finishes later, and drops it once it passes', async () => {
      await threeImages();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1 WHERE id = 3`);
      expect((await unpack.settleEntryScans()).passed).toBe(1);
      expect(await unpack.deleteEntryScanCopies()).toBe(1);
      expect(await q(`SELECT id FROM "Image"`)).toEqual([{ id: 2 }]);
      // Its copy goes; the rejected image's stays.
      expect((await orphans()).map((r) => r.imageId)).toEqual([null, 2, null]);
    });

    it("leaves the copy of the image that comes back above the deal's limit to the purge", async () => {
      await threeImages();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 4 WHERE id = 3`);
      await unpack.settleEntryScans();
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await orphans()).map((r) => r.imageId)).toEqual([null, 2, 3]);
    });
  });

  // Decided in civitai/civitai#10422.
  describe("a Final refused only for a rating above the deal's level", () => {
    /** A one-image zip Final rated `flags` above the PG-13 deal, settled, then deleted by its seller. */
    async function overLevelFinal(flags = '', items = [{ name: 'a.png', data: IMAGE_A }]) {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, items);
      await unpack.unpackFinals();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 4${flags}`);
      await unpack.settleEntryScans();
      await unpack.settleFinals();
      expect((await fileRow(fileId)).scanStatus).toBe('Failed');
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      await q(`UPDATE "ServiceDealFile" SET "removedAt" = now() - interval '1 day'`);
      return fileId;
    }

    it('keeps its copy while it is listed', async () => {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      await unpack.unpackFinals();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 4`);
      await unpack.settleEntryScans();
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
    });

    const purgedWithCopy = async (fileId: number) => {
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect(await q(`SELECT id FROM "Image"`)).toHaveLength(1);
      expect(await files.purgeRemovedFiles()).toBe(1);
      expect(await q(`SELECT id FROM "Image"`)).toEqual([]);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).toEqual([]);
    };
    const keptWithCopy = async (fileId: number, copies = 1) => {
      expect(await files.purgeRemovedFiles()).toBe(0);
      expect(await q(`SELECT id FROM "Image"`)).toHaveLength(copies);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).toHaveLength(1);
    };

    it('is purged once removed, its copy with it', async () => {
      await purgedWithCopy(await overLevelFinal());
    });

    it('is kept, with its copy, while a hold is on its deal', async () => {
      const fileId = await overLevelFinal();
      await q(`INSERT INTO "Report" (status) VALUES ('Pending')`);
      await q(
        `INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, (SELECT max(id) FROM "Report"))`
      );
      await keptWithCopy(fileId);
      await q(
        `UPDATE "Report" SET status = 'Unactioned', "createdAt" = now() - interval '400 days', "statusSetAt" = now() - interval '400 days'`
      );
      await purgedWithCopy(fileId);
    });

    it('is purged by a later run when one of its copies failed to delete', async () => {
      const fileId = await overLevelFinal('', [
        { name: 'a.png', data: IMAGE_A },
        { name: 'b.png', data: IMAGE_B },
      ]);
      images.deleteImages.mockRejectedValueOnce(new Error('store down'));
      expect(await files.purgeRemovedFiles()).toBe(0);
      expect(await q(`SELECT id FROM "Image"`)).toHaveLength(1);
      expect(await files.purgeRemovedFiles()).toBe(1);
      expect(await q(`SELECT id FROM "Image"`)).toEqual([]);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).toEqual([]);
    });

    it.each([
      ['no purge was tried', ''],
      [
        'its entry failed for another reason',
        `UPDATE "ServiceDealFileEntry" SET "failReason" = 'Rejected';
         INSERT INTO "ServiceDealFilePurge" ("fileId", "dealId", "size") SELECT id, "dealId", size FROM "ServiceDealFile"`,
      ],
    ])('is kept when its copy is gone and %s', async (_n, sql) => {
      const fileId = await overLevelFinal();
      await holder.db.exec(
        `UPDATE "ServiceDealFileEntry" SET "imageId" = NULL, "scanKey" = NULL; DELETE FROM "Image"; ${sql}`
      );
      expect(await files.purgeRemovedFiles()).toBe(0);
      expect(await q(`SELECT id FROM "ServiceDealFile" WHERE id = $1`, [fileId])).toHaveLength(1);
    });

    it('keeps its copy when a hold lands after its objects are deleted', async () => {
      const fileId = await overLevelFinal();
      const { s3Key } = await fileRow(fileId);
      const deleteObject = s3.deleteObject.getMockImplementation();
      s3.deleteObject.mockImplementation(async (bucketName: string, key: string) => {
        await deleteObject?.(bucketName, key);
        if (key !== s3Key) return;
        await q(`INSERT INTO "Report" (status) VALUES ('Pending')`);
        await q(
          `INSERT INTO "ServiceOfferingReport" ("serviceOfferingId", "reportId") VALUES (1, (SELECT max(id) FROM "Report"))`
        );
      });
      expect(await files.purgeRemovedFiles()).toBe(0);
      expect(images.deleteImages).not.toHaveBeenCalled();
      expect(await q(`SELECT id FROM "Image"`)).toHaveLength(1);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
    });

    it.each([
      ['flagged as a minor', `UPDATE "Image" SET minor = true`],
      ['flagged as a real person', `UPDATE "Image" SET poi = true`],
      ['held for review', `UPDATE "Image" SET "needsReview" = 'tag'`],
      ['blocked', `UPDATE "Image" SET "blockedFor" = 'TOS'`],
      ['sent back to be scanned', `UPDATE "Image" SET ingestion = 'Rescan'`],
      [
        'listed on a CSAM report',
        `INSERT INTO "CsamReport" ("userId", images) VALUES (9, '[{"id": 1}]')`,
      ],
      [
        'under an open child-safety report',
        `INSERT INTO "Report" (status, reason) VALUES ('Pending', 'CSAM');
         INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (1, (SELECT max(id) FROM "Report"))`,
      ],
    ])('is kept, with its copy, when its image is %s since', async (_n, sql) => {
      const fileId = await overLevelFinal();
      await holder.db.exec(sql);
      await keptWithCopy(fileId);
    });

    it('is kept, with its copy, when the image delete keeps the copy for its case', async () => {
      const fileId = await overLevelFinal();
      images.deleteImages.mockResolvedValueOnce([]);
      await keptWithCopy(fileId);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
    });

    it('is kept when its image row is gone or was never recorded', async () => {
      const fileId = await overLevelFinal();
      await q(`DELETE FROM "Image"`);
      await keptWithCopy(fileId, 0);
      await q(`UPDATE "ServiceDealFileEntry" SET "imageId" = NULL`);
      await keptWithCopy(fileId, 0);
    });
  });
});

describe('the finals malware scan flag', () => {
  /** A delivered deal whose one Final is an image, unpacked and ready for its scans. */
  async function deliveredImageFinal() {
    const dealId = await accepted();
    const fileId = await final(dealId, 'a.png', IMAGE_A);
    await unpack.unpackFinals();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    return { dealId, fileId };
  }

  it('with it on, hands the Final to the scan, which leaves it waiting', async () => {
    const { fileId } = await deliveredImageFinal();
    expect(malwareScan.submitted).toEqual([fileId]);
    await verdict('Scanned');
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Pending',
      malwareScanStatus: 'Pending',
    });
  });

  it('with it off, skips only the malware step: a clean Final passes and the deal completes', async () => {
    malwareScan.on.mockResolvedValue(false);
    const { dealId, fileId } = await deliveredImageFinal();
    expect(malwareScan.submitted).toEqual([]);
    expect((await fileRow(fileId)).malwareScanStatus).toBe('NotScanned');
    // The image inside is still scanned, and the Final waits for it.
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    await verdict('Scanned');
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    // Recorded as skipped, never as passed.
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Passed',
      malwareScanStatus: 'NotScanned',
    });
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    expect((await dealStatus(dealId)).status).toBe('Completed');
  });

  it('with it off, still fails the Final when an image is rejected, and holds the deal', async () => {
    malwareScan.on.mockResolvedValue(false);
    const { dealId, fileId } = await deliveredImageFinal();
    await verdict('Blocked');
    expect(await settle()).toEqual({ finalsFailed: 1, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Failed');
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
  });

  it('turned on, stops passing a Final whose scan was skipped and queues it for the scan', async () => {
    malwareScan.on.mockResolvedValue(false);
    const { fileId } = await deliveredImageFinal();
    await verdict('Scanned');
    malwareScan.on.mockResolvedValue(true);
    expect(await settle()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Pending',
      malwareScanStatus: 'Pending',
    });
    // Nothing is uploaded while settling; the scan step submits it.
    expect(malwareScan.submitted).toEqual([]);
    await unpack.settleMalwareScans();
    expect(malwareScan.submitted).toEqual([fileId]);
  });

  it('takes a pass on a skipped scan at the verdict entry point only while it is off', async () => {
    malwareScan.on.mockResolvedValue(false);
    const { fileId } = await deliveredImageFinal();
    await q(`UPDATE "ServiceDealFileEntry" SET "scanStatus" = 'Passed' WHERE "fileId" = $1`, [
      fileId,
    ]);
    malwareScan.on.mockResolvedValue(true);
    expect(await files.recordFinalScanResult({ fileId, verdict: 'Passed' })).toEqual({
      recorded: false,
      held: false,
    });
    malwareScan.on.mockResolvedValue(false);
    expect(await files.recordFinalScanResult({ fileId, verdict: 'Passed' })).toEqual({
      recorded: true,
      held: false,
    });
  });
});

type FileCaller = {
  userId: number;
  isModerator: boolean;
  servableLevels: number;
  canReviewCsam?: boolean;
  moderatorFetch?: boolean;
};

/** Whether the list offers `caller` a download of the file, and whether the download serves it. */
async function callerSees(dealId: number, fileId: number, caller: FileCaller) {
  const listed = (await files.listServiceDealFiles({ dealId, ...caller })).find(
    (row) => row.id === fileId
  );
  const download = await files.resolveServiceDealFileDownload({ fileId, ...caller });
  return { listed: listed?.canDownload, downloaded: download !== null };
}

/** The moderator dispute tool, as the mod endpoints call the service. */
const DISPUTE_TOOL: FileCaller = {
  userId: 99,
  isModerator: true,
  canReviewCsam: true,
  moderatorFetch: true,
  servableLevels: allBrowsingLevelsFlag,
};

/** What a CSAM reviewer who is no party to the deal is offered of a file, and gets. */
const reviewerSees = (dealId: number, fileId: number, servableLevels: number) =>
  callerSees(dealId, fileId, {
    userId: 99,
    isModerator: true,
    canReviewCsam: true,
    servableLevels,
  });

// Decided in civitai/civitai#10422.
describe('a Final rated outside the domain', () => {
  /** A completed R deal whose one Final (`name`) passed, its one image rated R. */
  async function completedRatedFinal(name: 'a.png' | 'result.zip') {
    malwareScan.on.mockResolvedValue(false);
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = 4`);
    const fileId =
      name === 'a.png'
        ? await final(dealId, name, IMAGE_A)
        : await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
    await unpack.unpackFinals();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await verdict('Scanned', '', 4);
    await unpack.settleEntryScans();
    await q(
      `UPDATE "ServiceDealFile" SET "repackedAt" = now(), "deliveryKey" = 'k/delivered',
         "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [fileId]
    );
    await unpack.settleFinals();
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
    await q(
      `UPDATE "ServiceDeal" SET status = 'Completed', "completedAt" = now(), "releaseAt" = now() WHERE id = $1`,
      [dealId]
    );
    return { dealId, fileId };
  }
  const listed = async (dealId: number, fileId: number, servableLevels: number) =>
    (
      await files.listServiceDealFiles({
        dealId,
        userId: BUYER,
        isModerator: false,
        servableLevels,
      })
    ).find((row) => row.id === fileId);
  const download = (fileId: number, servableLevels: number) =>
    files.resolveServiceDealFileDownload({
      fileId,
      userId: BUYER,
      isModerator: false,
      servableLevels,
    });

  it.each(['a.png', 'result.zip'] as const)(
    'is served, and listed downloadable, only where its rating may be shown (%s)',
    async (name) => {
      const { dealId, fileId } = await completedRatedFinal(name);
      expect(await download(fileId, 31)).not.toBeNull();
      expect(await listed(dealId, fileId, 31)).toMatchObject({ canDownload: true });
      expect((await listed(dealId, fileId, 31))?.downloadOffDomain).toBeUndefined();
      expect(await download(fileId, 3)).toBeNull();
      expect(await listed(dealId, fileId, 3)).toMatchObject({
        canDownload: false,
        downloadOffDomain: true,
        fileName: name,
      });
    }
  );

  it('a file with no rated image is still refused while an image in it is held', async () => {
    const { dealId, fileId } = await completedRatedFinal('result.zip');
    await q(`UPDATE "ServiceDealFileEntry" SET "nsfwLevel" = NULL`);
    await q(`UPDATE "Image" SET minor = true`);
    expect(await download(fileId, 31)).toBeNull();
    expect(await listed(dealId, fileId, 31)).toMatchObject({ canDownload: false });
    expect((await listed(dealId, fileId, 31))?.downloadOffDomain).toBeUndefined();
  });

  it('gives a seller who moderates their own original of a held file, never its delivery copy', async () => {
    const { dealId, fileId } = await completedRatedFinal('result.zip');
    await q(`UPDATE "Image" SET minor = true`);
    const asSeller = (delivered: boolean) =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: SELLER,
        isModerator: true,
        delivered,
        servableLevels: 31,
      });
    expect(await asSeller(false)).toMatchObject({ key: (await fileRow(fileId)).s3Key });
    expect(await asSeller(true)).toBeNull();
    // The list answers for the original.
    const [listedFile] = (
      await files.listServiceDealFiles({
        dealId,
        userId: SELLER,
        isModerator: true,
        servableLevels: 31,
      })
    ).filter((row) => row.id === fileId);
    expect(listedFile).toMatchObject({ canDownload: true });
  });

  describe('once an image in it is gone', () => {
    /** What the seller, the buyer and the moderator dispute tool are offered of the file, and get. */
    const everyoneSees = async (dealId: number, fileId: number) => ({
      seller: await callerSees(dealId, fileId, {
        userId: SELLER,
        isModerator: false,
        servableLevels: 31,
      }),
      buyer: await callerSees(dealId, fileId, {
        userId: BUYER,
        isModerator: false,
        servableLevels: 31,
      }),
      disputeTool: await callerSees(dealId, fileId, DISPUTE_TOOL),
    });
    const refused = { listed: false, downloaded: false };
    const served = { listed: true, downloaded: true };

    it('refuses everyone a file whose image was blocked as CSAM and then deleted', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      await q(`UPDATE "Image" SET "blockedFor" = 'CSAM'`);
      await q(`DELETE FROM "Image"`);
      expect(await everyoneSees(dealId, fileId)).toEqual({
        seller: refused,
        buyer: refused,
        disputeTool: refused,
      });
    });

    const finalsClear = async (dealId: number) => {
      const sql = Prisma.sql`SELECT ${escrow.dealFinalsClear(
        Prisma.sql`d`
      )} AS clear FROM "ServiceDeal" d WHERE d.id = ${dealId}::int`;
      return (await q<{ clear: boolean }>(sql.text, sql.values as unknown[]))[0].clear;
    };
    const marker = async (fileId: number) =>
      (
        await q<{ copyDeleteStartedAt: Date | null }>(
          `SELECT "copyDeleteStartedAt" FROM "ServiceDealFileEntry" WHERE "fileId" = $1`,
          [fileId]
        )
      )[0].copyDeleteStartedAt;

    const stranded = () =>
      loggingMock.logToAxiom.mock.calls.filter(
        ([entry]) => (entry as { name?: string }).name === 'deal_copy_settle_stranded'
      );

    it('strands, refused and logged, our own copy delete that stopped before its clear', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      expect(await finalsClear(dealId)).toBe(true);
      images.deleteImages.mockImplementationOnce(async (ids: number[]) => {
        await q(`DELETE FROM "Image" WHERE id = ANY($1::int[])`, [ids]);
        throw new Error('stopped after the delete');
      });
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect(await marker(fileId)).not.toBeNull();
      loggingMock.logToAxiom.mockClear();

      // Only an id our own delete returns is let go; a retry cannot tell its delete from another's.
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
      expect(await finalsClear(dealId)).toBe(false);
      expect((await everyoneSees(dealId, fileId)).buyer).toEqual(refused);
      expect(stranded()).toHaveLength(1);
      expect(JSON.stringify(stranded())).not.toContain('scan-key');
    });

    it('keeps a copy deleted elsewhere while marked and held pointed', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      images.deleteImages.mockImplementationOnce(async () => {
        await q(`DELETE FROM "Image"`);
        return [];
      });
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
      expect(await finalsClear(dealId)).toBe(false);
    });

    it('lets go of a copy our own delete returned (control)', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      expect(await unpack.deleteEntryScanCopies()).toBe(1);
      expect((await entries(fileId))[0]).toMatchObject({ imageId: null, scanKey: null });
      expect(await finalsClear(dealId)).toBe(true);
    });

    it('keeps a copy gone without our delete pointed, so the finals stay not clear', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      await q(`DELETE FROM "Image"`);
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
      expect(await marker(fileId)).toBeNull();
      expect(await finalsClear(dealId)).toBe(false);
    });

    it('keeps a copy kept for its case pointed and unmarked, so a later outside delete stays refused', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      images.deleteImages.mockResolvedValue([]);
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await entries(fileId))[0].imageId).not.toBeNull();
      expect(await marker(fileId)).toBeNull();
      expect(await finalsClear(dealId)).toBe(true);
      await q(`DELETE FROM "Image"`);
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect(await finalsClear(dealId)).toBe(false);
    });

    it('serves a file whose passed image copy was let go', async () => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      await q(`DELETE FROM "Image"`);
      await q(`UPDATE "ServiceDealFileEntry" SET "imageId" = NULL, "scanKey" = NULL`);
      expect(await everyoneSees(dealId, fileId)).toEqual({
        seller: served,
        buyer: served,
        disputeTool: served,
      });
    });

    it.each([
      ['refuses', 'An image in this file was rejected when it was checked.', false],
      ['still serves', SERVICE_FINAL_OVER_LEVEL_REASON, true],
    ])(
      '%s the seller a file whose image entry failed with: %s',
      async (_n, failReason, sellerServed) => {
        const { dealId, fileId } = await completedRatedFinal('result.zip');
        await q(`DELETE FROM "Image"`);
        await q(
          `UPDATE "ServiceDealFileEntry" SET "imageId" = NULL, "scanStatus" = 'Failed', "failReason" = $1`,
          [failReason]
        );
        expect((await everyoneSees(dealId, fileId)).seller).toEqual(
          sellerServed ? served : refused
        );
      }
    );
  });

  it('is not refused because its owner is named on a CSAM report, only for its own flag', async () => {
    const { dealId, fileId } = await completedRatedFinal('result.zip');
    await q(`UPDATE "Image" SET "userId" = $1`, [SELLER]);
    await q(`INSERT INTO "CsamReport" ("userId", images) VALUES ($1, '[]')`, [SELLER]);
    expect(await download(fileId, 31)).not.toBeNull();
    expect(await listed(dealId, fileId, 31)).toMatchObject({ canDownload: true });
    await q(`UPDATE "Image" SET "needsReview" = 'csam'`);
    expect(await download(fileId, 31)).toBeNull();
    expect(await listed(dealId, fileId, 31)).toMatchObject({ canDownload: false });
  });

  it.each([
    ['an image in it is held', async () => (await q(`UPDATE "Image" SET minor = true`), 31)],
    ['this host may not show its rating', async () => 3],
    [
      'it still sits at the key its uploader holds',
      async () => (
        await q(`UPDATE "ServiceDealFile" SET "s3Key" = 'service-deals/uploads/1/0/f'`), 31
      ),
    ],
  ])(
    'once removed, is refused to a CSAM reviewer, listed and downloaded alike, when %s',
    async (_n, refuse) => {
      const { dealId, fileId } = await completedRatedFinal('result.zip');
      await q(`UPDATE "ServiceDealFile" SET "removedAt" = now() WHERE id = $1`, [fileId]);
      expect(await reviewerSees(dealId, fileId, 31)).toEqual({ listed: true, downloaded: true });
      expect(await reviewerSees(dealId, fileId, await refuse())).toEqual({
        listed: false,
        downloaded: false,
      });
    }
  );

  it('rated where no domain may show it, is refused with no other domain offered', async () => {
    const { dealId, fileId } = await completedRatedFinal('result.zip');
    expect(await listed(dealId, fileId, 3)).toMatchObject({ downloadOffDomain: true });
    await q(`UPDATE "ServiceDealFileEntry" SET "nsfwLevel" = 32`);
    expect(await download(fileId, 31)).toBeNull();
    expect(await listed(dealId, fileId, 31)).toMatchObject({ canDownload: false });
    expect((await listed(dealId, fileId, 31))?.downloadOffDomain).toBeUndefined();
  });

  it('a file with no rated image is served on any domain', async () => {
    const { dealId, fileId } = await completedRatedFinal('result.zip');
    await q(`UPDATE "ServiceDealFileEntry" SET "nsfwLevel" = NULL`);
    expect(await download(fileId, 3)).not.toBeNull();
    expect(await listed(dealId, fileId, 3)).toMatchObject({ canDownload: true });
  });
});

describe('the finals malware scan', () => {
  /** What the orchestrator returned for a clean file: the count is only in the scanner's summary. */
  const CLEAN = {
    $type: 'modelClamScan',
    output: {
      status: 'clean',
      infected: false,
      output: [
        'blob: OK',
        '----------- SCAN SUMMARY -----------',
        'Scanned files: 1',
        'Infected files: 0',
      ].join('\n'),
    },
  };
  const NOT_PICKLE = {
    $type: 'modelPickleScan',
    output: { status: 'skipped', skipped: true, skipReason: 'unknown-format' },
  };
  /** What the orchestrator returned for the EICAR test file: the workflow still succeeded. */
  const EICAR = {
    $type: 'modelClamScan',
    output: { status: 'infected', infected: true, output: 'stdin: Eicar-Test-Signature FOUND' },
  };
  const CLAM_ERROR = { $type: 'modelClamScan', output: { status: 'error' } };
  const workflow = (status: string, steps: unknown[]) => ({ status, steps });

  /** The upload answers with a signed URL anyone holding it can read: never kept, never logged. */
  const SIGNED_URL = 'https://blobs.test/signed-secret';
  const fetchMock = vi.fn();
  /** The workflow each id reads as; an id with none set reads as still running. */
  const workflows = new Map<string, ReturnType<typeof workflow>>();
  let submissions = 0;

  beforeEach(() => {
    setEnv({
      ORCHESTRATOR_ACCESS_TOKEN: 'test-token',
      ORCHESTRATOR_ENDPOINT: 'https://orch.test/',
    });
    workflows.clear();
    submissions = 0;
    let blobs = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ id: `blob-${++blobs}.bin`, url: `${SIGNED_URL}/${blobs}` }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(orchestrator.submitWorkflow).mockReset();
    vi.mocked(orchestrator.submitWorkflow).mockImplementation((async () => ({
      data: { id: `wf-${++submissions}` },
    })) as never);
    vi.mocked(orchestrator.getWorkflow).mockReset();
    vi.mocked(orchestrator.getWorkflow).mockImplementation((async ({
      path,
    }: {
      path: { workflowId: string };
    }) => ({
      data: workflows.get(path.workflowId) ?? workflow('processing', []),
    })) as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Storage answers every read from the bucket; a whole-object stream names the object's key. */
  const serveBucket = () =>
    s3.send.mockImplementation(async (command: { input: { Key: string; Range?: string } }) => {
      const data = bucket.objects.get(command.input.Key) ?? Buffer.alloc(0);
      return {
        Body: {
          transformToByteArray: async () => (command.input.Range ? data.subarray(0, 16) : data),
          transformToWebStream: () => ({ streamOf: command.input.Key }),
        },
      };
    });

  /** A delivered deal whose one Final is unpacked, its images passed, and handed to the scan. */
  async function delivered(fileName = 'a.png', content = IMAGE_A) {
    const dealId = await accepted();
    const fileId = await final(dealId, fileName, content);
    serveBucket();
    await unpack.unpackFinals();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await verdict('Scanned');
    return { dealId, fileId };
  }

  /** A Final waiting for its scan whose hand-off never reached the orchestrator. */
  async function lostHandOff() {
    const dealId = await accepted();
    const fileId = await final(dealId, 'a.png', IMAGE_A);
    serveBucket();
    malwareScan.refuse.add(fileId);
    await unpack.unpackFinals();
    malwareScan.refuse.clear();
    return { dealId, fileId };
  }

  const run = async () => {
    const scans = await unpack.settleMalwareScans();
    await unpack.settleEntryScans();
    return { ...scans, ...(await unpack.settleFinals()) };
  };

  type ScanRecord = FileRecord & {
    malwareScanWorkflowId: string | null;
    malwareScanAttempts: number;
    malwareScanSubmittedAt: Date | null;
    malwareScanStartedAt: Date | null;
  };
  const scanRow = async (id: number) =>
    (await q<ScanRecord>(`SELECT * FROM "ServiceDealFile" WHERE id = $1`, [id]))[0];
  const age = (fileId: number, column: string, ms: number) =>
    q(
      `UPDATE "ServiceDealFile" SET "${column}" = now() - ($2::int * interval '1 millisecond') WHERE id = $1`,
      [fileId, ms]
    );

  const asBuyer = (fileId: number) =>
    files.resolveServiceDealFileDownload({
      servableLevels: 31,
      fileId,
      userId: BUYER,
      isModerator: false,
    });
  const listedForBuyer = async (dealId: number, fileId: number) =>
    (
      await files.listServiceDealFiles({
        dealId,
        userId: BUYER,
        isModerator: false,
        servableLevels: 31,
      })
    ).find((row) => row.id === fileId);

  describe('reading a workflow', () => {
    const pickle = (status: string, extra = {}) => ({
      $type: 'modelPickleScan',
      output: { status, ...extra },
    });
    it.each([
      ['clean, not a pickle', workflow('succeeded', [CLEAN, NOT_PICKLE]), 'Passed'],
      ['clean, clean pickle', workflow('succeeded', [CLEAN, pickle('clean')]), 'Passed'],
      [
        'clean, safetensors',
        workflow('succeeded', [CLEAN, pickle('skippedSafetensors')]),
        'Passed',
      ],
      ['EICAR, workflow succeeded', workflow('succeeded', [EICAR, NOT_PICKLE]), 'Failed'],
      ['EICAR, workflow still running', workflow('processing', [EICAR]), 'Failed'],
      [
        'infected by flag alone',
        workflow('succeeded', [{ $type: 'modelClamScan', output: { infected: true } }, NOT_PICKLE]),
        'Failed',
      ],
      [
        'infected by status alone',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'infected' } },
          NOT_PICKLE,
        ]),
        'Failed',
      ],
      [
        'dangerous imports by flag alone',
        workflow('succeeded', [
          CLEAN,
          { $type: 'modelPickleScan', output: { dangerousImportsFound: true } },
        ]),
        'Failed',
      ],
      [
        'dangerous imports by status alone',
        workflow('succeeded', [CLEAN, pickle('dangerousImportsFound')]),
        'Failed',
      ],
      [
        'dangerous pickle imports',
        workflow('succeeded', [
          CLEAN,
          pickle('dangerousImportsFound', { dangerousImportsFound: true }),
        ]),
        'Failed',
      ],
      ['virus scan errored', workflow('succeeded', [CLAM_ERROR, NOT_PICKLE]), 'Retry'],
      [
        'virus scan timed out',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'timeout' } },
          NOT_PICKLE,
        ]),
        'Retry',
      ],
      ['pickle parse error', workflow('succeeded', [CLEAN, pickle('parseError')]), 'Failed'],
      ['pickle step missing', workflow('succeeded', [CLEAN]), 'Retry'],
      [
        'clean, counted in the step output',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'clean', scannedFileCount: 1 } },
          NOT_PICKLE,
        ]),
        'Passed',
      ],
      [
        'clean but its count says nothing was read',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'clean', scannedFileCount: 0 } },
          NOT_PICKLE,
        ]),
        'Retry',
      ],
      [
        'clean but its summary says nothing was read',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'clean', output: 'Scanned files: 0' } },
          NOT_PICKLE,
        ]),
        'Retry',
      ],
      [
        'clean but it does not say what it read',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'clean' } },
          NOT_PICKLE,
        ]),
        'Retry',
      ],
      ['clean but the workflow failed', workflow('failed', [CLEAN, NOT_PICKLE]), 'Retry'],
      ['expired', workflow('expired', []), 'Retry'],
      ['canceled', workflow('canceled', []), 'Retry'],
      [
        'encrypted content the virus scan could not read',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'encrypted', scannedFileCount: 1 } },
          NOT_PICKLE,
        ]),
        'Failed',
      ],
      [
        'a virus scan stopped at a limit',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'limitsExceeded', scannedFileCount: 1 } },
          NOT_PICKLE,
        ]),
        'Failed',
      ],
      [
        'a virus scan stopped at a limit, in another case',
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'LimitsExceeded', scannedFileCount: 1 } },
          NOT_PICKLE,
        ]),
        'Failed',
      ],
      [
        'encrypted content while the workflow still runs',
        workflow('processing', [
          { $type: 'modelClamScan', output: { status: 'encrypted', scannedFileCount: 1 } },
        ]),
        'Failed',
      ],
      [
        'an unknown virus status',
        workflow('succeeded', [{ $type: 'modelClamScan', output: { status: 'new' } }, NOT_PICKLE]),
        'Retry',
      ],
      ['still running', workflow('processing', [CLEAN]), 'Running'],
      ['an unknown workflow status', workflow('somethingNew', [CLEAN, NOT_PICKLE]), 'Running'],
    ])('%s reads as %s', (_name, wf, expected) => {
      expect(scan.readFinalScan(wf)).toBe(expected);
    });
  });

  describe('a pickle parse error', () => {
    const pickleParseError = {
      $type: 'modelPickleScan',
      output: { status: 'parseError', dangerousImportsFound: false },
    };
    const clam = (status: string, extra = {}) => ({
      $type: 'modelClamScan',
      output: { status, infected: false, scannedFileCount: 1, ...extra },
    });

    it.each([
      [
        'a video with a clean virus scan',
        { video: true },
        workflow('succeeded', [CLEAN, pickleParseError]),
        'Passed',
      ],
      [
        'a video the virus scan could not read in full',
        { video: true },
        workflow('succeeded', [clam('limitsExceeded'), pickleParseError]),
        'Failed',
      ],
      [
        'a video the virus scan found infected',
        { video: true },
        workflow('succeeded', [EICAR, pickleParseError]),
        'Failed',
      ],
      [
        'a video the virus scan called clean without reading a file',
        { video: true },
        workflow('succeeded', [
          { $type: 'modelClamScan', output: { status: 'clean', infected: false } },
          pickleParseError,
        ]),
        'Retry',
      ],
      [
        'a video the virus scan errored on',
        { video: true },
        workflow('succeeded', [CLAM_ERROR, pickleParseError]),
        'Retry',
      ],
      [
        'a video with dangerous imports',
        { video: true },
        workflow('succeeded', [
          CLEAN,
          {
            $type: 'modelPickleScan',
            output: { status: 'parseError', dangerousImportsFound: true },
          },
        ]),
        'Failed',
      ],
      [
        'a file not accepted as video',
        {},
        workflow('succeeded', [CLEAN, pickleParseError]),
        'Failed',
      ],
    ])('reads %s', (_name, options, wf, expected) => {
      expect(scan.readFinalScan(wf, options)).toBe(expected);
    });

    const videoClip = mp4Clip({ seconds: 10 });
    const probeTen = async () => ({ width: 640, height: 360, duration: 10.1 });
    const serveVideo = () =>
      s3.send.mockImplementation(async (command: { input: { Key: string; Range?: string } }) =>
        command.input.Range
          ? body(videoClip.subarray(0, 16))
          : {
              Body: {
                transformToByteArray: async () => videoClip,
                transformToWebStream: () => ({ streamOf: command.input.Key }),
              },
              ETag: '"v1"',
              VersionId: 'ver1',
            }
      );
    const scannedEtagOf = async (fileId: number) =>
      (
        await q<{ scannedEtag: string | null }>(
          `SELECT "scannedEtag" FROM "ServiceDealFile" WHERE id = $1`,
          [fileId]
        )
      )[0].scannedEtag;
    async function deliveredVideo(fileName = 'clip.mp4') {
      const dealId = await accepted();
      const fileId = await final(dealId, fileName, videoClip);
      serveVideo();
      await unpack.unpackFinals({ probeVideo: probeTen });
      await files.deliverServiceDeal({ dealId, userId: SELLER });
      await verdict('Scanned');
      return { dealId, fileId };
    }

    it('passes a video unpack accepted, which the pickle scan could not read', async () => {
      const { fileId } = await deliveredVideo();
      expect(await scannedEtagOf(fileId)).toBe('"v1"');
      workflows.set('wf-1', workflow('succeeded', [CLEAN, pickleParseError]));
      expect(await run()).toMatchObject({ scansPassed: 1, finalsPassed: 1 });
      expect(await fileRow(fileId)).toMatchObject({
        scanStatus: 'Passed',
        malwareScanStatus: 'Passed',
      });
    });

    it('does not pass a video whose pickle scan found dangerous imports, even with a clean virus scan', async () => {
      const { fileId } = await deliveredVideo();
      workflows.set(
        'wf-1',
        workflow('succeeded', [
          CLEAN,
          {
            $type: 'modelPickleScan',
            output: { status: 'parseError', dangerousImportsFound: true },
          },
        ])
      );
      expect(await run()).toMatchObject({ scansFailed: 1, finalsPassed: 0 });
      expect((await fileRow(fileId)).malwareScanStatus).toBe('Failed');
    });

    it('fails a file that only has a video name', async () => {
      const { fileId } = await deliveredVideo();
      // The name is the same; what unpack recorded about the bytes is not.
      await q(`UPDATE "ServiceDealFile" SET "scannedEtag" = NULL WHERE id = $1`, [fileId]);
      workflows.set('wf-1', workflow('succeeded', [CLEAN, pickleParseError]));
      expect(await run()).toMatchObject({ scansPassed: 0, scansFailed: 1 });
      expect((await fileRow(fileId)).malwareScanStatus).toBe('Failed');
    });

    it('fails an image whose pickle scan could not read it', async () => {
      const { fileId } = await delivered();
      expect(await scannedEtagOf(fileId)).toBeNull();
      workflows.set('wf-1', workflow('succeeded', [CLEAN, pickleParseError]));
      expect(await run()).toMatchObject({ scansPassed: 0, scansFailed: 1 });
    });

    it('leaves scannedEtag empty for a refused .mp4 name, an image and a zip: only unpackVideo sets it', async () => {
      const dealId = await accepted();
      const notVideo = await final(dealId, 'clip.mp4', IMAGE_A);
      const image = await final(dealId, 'a.png', IMAGE_A);
      const zip = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      s3.send.mockImplementation(async (command: { input: { Key: string; Range?: string } }) => {
        const data = bucket.objects.get(command.input.Key) ?? Buffer.alloc(0);
        return {
          Body: {
            transformToByteArray: async () => (command.input.Range ? data.subarray(0, 16) : data),
            transformToWebStream: () => ({ streamOf: command.input.Key }),
          },
          ETag: '"v1"',
        };
      });
      while (await unpack.unpackFinals({ probeVideo: probeTen }));
      expect(await fileRow(notVideo)).toMatchObject({ scanStatus: 'Failed' });
      for (const id of [notVideo, image, zip]) expect(await scannedEtagOf(id)).toBeNull();
    });
  });

  it('uploads the delivery object, scans the blob, and passes the Final on a clean reading', async () => {
    const { dealId, fileId } = await delivered();
    const row = await scanRow(fileId);

    // The bytes uploaded are the object a buyer would download.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://orch.test/v2/consumer/blobs');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.body).toEqual({ streamOf: row.s3Key });
    const submitted = vi.mocked(orchestrator.submitWorkflow).mock.calls[0][0] as unknown as {
      body: { steps: { $type: string; input: { model: string } }[] };
    };
    expect(submitted.body.steps.map((step) => [step.$type, step.input.model])).toEqual([
      ['modelClamScan', 'urn:air:other:other:orchestrator:blob@blob-1.bin'],
      ['modelPickleScan', 'urn:air:other:other:orchestrator:blob@blob-1.bin'],
    ]);
    expect(row).toMatchObject({ malwareScanWorkflowId: 'wf-1', malwareScanAttempts: 1 });

    // Running: nothing is decided.
    expect(await run()).toMatchObject({ scansPassed: 0, finalsPassed: 0 });
    expect((await fileRow(fileId)).malwareScanStatus).toBe('Pending');

    workflows.set('wf-1', workflow('succeeded', [CLEAN, NOT_PICKLE]));
    expect(await run()).toMatchObject({ scansPassed: 1, finalsPassed: 1 });
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Passed',
      malwareScanStatus: 'Passed',
    });

    // The upload's signed URL went nowhere: not into the row, not into a log line.
    const rows = await q(`SELECT * FROM "ServiceDealFile"`);
    expect(JSON.stringify(rows)).not.toContain(SIGNED_URL);
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain(SIGNED_URL);

    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    expect(await asBuyer(fileId)).toMatchObject({ key: row.s3Key });
    expect(await listedForBuyer(dealId, fileId)).toMatchObject({ canDownload: true });
  });

  it('fails the Final and holds the deal on an infected reading, though the workflow succeeded', async () => {
    const { dealId, fileId } = await delivered();
    workflows.set('wf-1', workflow('succeeded', [EICAR, NOT_PICKLE]));
    expect(await run()).toMatchObject({ scansFailed: 1, finalsFailed: 1 });
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      malwareScanStatus: 'Failed',
    });
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
    // Nothing is submitted for it again, and a later reading changes nothing.
    workflows.set('wf-1', workflow('succeeded', [CLEAN, NOT_PICKLE]));
    expect(await run()).toMatchObject({ scansPassed: 0, scansSubmitted: 0 });
    expect((await fileRow(fileId)).malwareScanStatus).toBe('Failed');
  });

  it('submits a Final at most once while it waits on a workflow', async () => {
    const { dealId, fileId } = await delivered();
    const row = await scanRow(fileId);
    await scan.submitFinalScan({
      id: fileId,
      dealId,
      s3Key: row.s3Key,
      mimeType: 'image/png',
      size: 1,
    });
    expect(orchestrator.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(await scanRow(fileId)).toMatchObject({
      malwareScanWorkflowId: 'wf-1',
      malwareScanAttempts: 1,
    });
  });

  it('does not attach a workflow to a Final settled while it was being submitted', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'a.png', IMAGE_A);
    serveBucket();
    vi.mocked(orchestrator.submitWorkflow).mockImplementation((async () => {
      await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Failed' WHERE id = $1`, [
        fileId,
      ]);
      return { data: { id: 'wf-late' } };
    }) as never);
    await unpack.unpackFinals();
    expect(await scanRow(fileId)).toMatchObject({
      malwareScanStatus: 'Failed',
      malwareScanWorkflowId: null,
    });
  });

  it('does not attach a workflow from a superseded attempt', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'a.png', IMAGE_A);
    serveBucket();
    vi.mocked(orchestrator.submitWorkflow).mockImplementation((async () => {
      // Another attempt was counted while this one was in flight.
      await q(
        `UPDATE "ServiceDealFile" SET "malwareScanAttempts" = "malwareScanAttempts" + 1 WHERE id = $1`,
        [fileId]
      );
      return { data: { id: 'wf-old' } };
    }) as never);
    await unpack.unpackFinals();
    expect((await scanRow(fileId)).malwareScanWorkflowId).toBeNull();
  });

  it('scans every Final, a model file included', async () => {
    await delivered(
      'weights.safetensors',
      Buffer.concat([Buffer.from([8, 0, 0, 0, 0, 0, 0, 0]), Buffer.from('{"w":{}}', 'latin1')])
    );
    expect(orchestrator.submitWorkflow).toHaveBeenCalledTimes(1);
  });

  describe('the sweep', () => {
    it('submits a Final whose hand-off was lost, uploading what the buyer would download', async () => {
      const { fileId } = await lostHandOff();
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: null,
        malwareScanAttempts: 0,
        unpackedAt: expect.any(Date),
      });
      // As a repacked zip has: the buyer's download is the server-built archive, not the upload.
      await q(
        `UPDATE "ServiceDealFile" SET "deliveryKey" = 'service-deals/delivery/built', "deliverySize" = 4321 WHERE id = $1`,
        [fileId]
      );
      expect(await unpack.settleMalwareScans()).toMatchObject({ scansSubmitted: 1 });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.body).toEqual({ streamOf: 'service-deals/delivery/built' });
      expect(init.headers['Content-Length']).toBe('4321');
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: 'wf-1',
        malwareScanAttempts: 1,
      });
    });

    it('submits again after a failed submission, once the retry wait is over', async () => {
      const dealId = await accepted();
      const fileId = await final(dealId, 'a.png', IMAGE_A);
      serveBucket();
      vi.mocked(orchestrator.submitWorkflow).mockImplementation((async () => ({
        data: undefined,
      })) as never);
      await unpack.unpackFinals();
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: null,
        malwareScanAttempts: 1,
      });
      vi.mocked(orchestrator.submitWorkflow).mockImplementation((async () => ({
        data: { id: 'wf-ok' },
      })) as never);
      expect(await unpack.settleMalwareScans()).toMatchObject({ scansSubmitted: 0 });
      await age(fileId, 'malwareScanSubmittedAt', SERVICE_FINAL_SCAN_RETRY_MS + 60_000);
      expect(await unpack.settleMalwareScans()).toMatchObject({ scansSubmitted: 1 });
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: 'wf-ok',
        malwareScanAttempts: 2,
      });
    });

    it('drops a workflow that could not reach a verdict and submits the file again', async () => {
      const { fileId } = await delivered();
      workflows.set('wf-1', workflow('succeeded', [CLAM_ERROR, NOT_PICKLE]));
      expect(await run()).toMatchObject({ scansRetried: 1, finalsFailed: 0 });
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: null,
        malwareScanStatus: 'Pending',
      });
      await age(fileId, 'malwareScanSubmittedAt', SERVICE_FINAL_SCAN_RETRY_MS + 60_000);
      await run();
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanWorkflowId: 'wf-2',
        malwareScanAttempts: 2,
      });
    });

    it('abandons a workflow with no verdict past the stale window', async () => {
      const { fileId } = await delivered();
      expect(await run()).toMatchObject({ scansRetried: 0 });
      await age(fileId, 'malwareScanSubmittedAt', SERVICE_FINAL_SCAN_STALE_MS + 60_000);
      expect(await run()).toMatchObject({ scansRetried: 1, scansSubmitted: 1 });
      expect((await scanRow(fileId)).malwareScanWorkflowId).toBe('wf-2');
    });

    it('fails the malware scan once the attempts are used, with a reason the seller can act on', async () => {
      const { dealId, fileId } = await delivered();
      await q(`UPDATE "ServiceDealFile" SET "malwareScanAttempts" = $2 WHERE id = $1`, [
        fileId,
        SERVICE_FINAL_SCAN_MAX_ATTEMPTS,
      ]);
      workflows.set('wf-1', workflow('expired', []));
      expect(await run()).toMatchObject({ scansRetried: 1, scansGivenUp: 1, finalsFailed: 1 });
      expect(await fileRow(fileId)).toMatchObject({
        scanStatus: 'Failed',
        malwareScanStatus: 'Failed',
        failReason: 'This file could not be checked. Upload it again.',
      });
      expect((await dealStatus(dealId)).status).toBe('Disputed');
    });

    it('does not give up on the last attempt while its workflow is still running', async () => {
      const { fileId } = await delivered();
      await q(`UPDATE "ServiceDealFile" SET "malwareScanAttempts" = $2 WHERE id = $1`, [
        fileId,
        SERVICE_FINAL_SCAN_MAX_ATTEMPTS,
      ]);
      expect(await run()).toMatchObject({ scansGivenUp: 0, finalsFailed: 0 });
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanStatus: 'Pending',
        malwareScanWorkflowId: 'wf-1',
      });
    });

    it('leaves a scan alone when the orchestrator cannot be read', async () => {
      const { fileId } = await delivered();
      vi.mocked(orchestrator.getWorkflow).mockImplementation((async () => {
        throw new Error('orchestrator down');
      }) as never);
      expect(await run()).toMatchObject({ scansRetried: 0, scansGivenUp: 0, finalsFailed: 0 });
      vi.mocked(orchestrator.getWorkflow).mockImplementation((async () => ({
        data: undefined,
      })) as never);
      expect(await run()).toMatchObject({ scansRetried: 0, scansGivenUp: 0, finalsFailed: 0 });
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanStatus: 'Pending',
        malwareScanWorkflowId: 'wf-1',
      });
    });

    it('fails the malware scan past the give-up window, even with a workflow still running', async () => {
      const { fileId } = await delivered();
      await age(fileId, 'malwareScanStartedAt', SERVICE_FINAL_SCAN_GIVE_UP_MS + 60_000);
      expect(await run()).toMatchObject({ scansGivenUp: 1, finalsFailed: 1 });
      expect((await fileRow(fileId)).malwareScanStatus).toBe('Failed');
    });

    it('with the scan off, records a waiting Final as skipped and gives nothing up', async () => {
      const { fileId } = await lostHandOff();
      await age(fileId, 'repackedAt', SERVICE_FINAL_SCAN_GIVE_UP_MS + 60_000);
      malwareScan.on.mockResolvedValue(false);
      expect(await unpack.settleMalwareScans()).toMatchObject({
        scansGivenUp: 0,
        scansSubmitted: 0,
      });
      expect((await fileRow(fileId)).malwareScanStatus).toBe('NotScanned');
      expect(orchestrator.submitWorkflow).not.toHaveBeenCalled();
    });

    it('turned back on, scans a Final it skipped on a fresh clock instead of giving up on it', async () => {
      // Submitted long ago with its attempts used, then the scan was turned off and it was skipped.
      const { fileId } = await delivered();
      await q(
        `UPDATE "ServiceDealFile" SET "malwareScanAttempts" = $2, "malwareScanStatus" = 'NotScanned' WHERE id = $1`,
        [fileId, SERVICE_FINAL_SCAN_MAX_ATTEMPTS]
      );
      for (const column of ['malwareScanStartedAt', 'malwareScanSubmittedAt', 'repackedAt'])
        await age(fileId, column, SERVICE_FINAL_SCAN_GIVE_UP_MS + 60_000);

      await run(); // settleFinals queues it for the scan
      const queued = await scanRow(fileId);
      expect(queued).toMatchObject({
        malwareScanStatus: 'Pending',
        malwareScanWorkflowId: null,
        malwareScanAttempts: 0,
        malwareScanSubmittedAt: null,
      });
      expect(Date.now() - queued.malwareScanStartedAt!.getTime()).toBeLessThan(
        SERVICE_FINAL_SCAN_GIVE_UP_MS
      );
      expect(await run()).toMatchObject({ scansGivenUp: 0, scansSubmitted: 1 });
      expect(await scanRow(fileId)).toMatchObject({
        malwareScanStatus: 'Pending',
        malwareScanWorkflowId: 'wf-2',
        malwareScanAttempts: 1,
      });
    });

    it('turned on, submits the Finals it skipped one per run', async () => {
      malwareScan.on.mockResolvedValue(false);
      const first = await delivered();
      const second = await delivered();
      malwareScan.on.mockResolvedValue(true);
      await run(); // queues both; nothing is uploaded while settling
      expect(fetchMock).not.toHaveBeenCalled();
      await run();
      expect((await scanRow(first.fileId)).malwareScanWorkflowId).toBe('wf-1');
      expect((await scanRow(second.fileId)).malwareScanWorkflowId).toBeNull();
      await run();
      expect((await scanRow(second.fileId)).malwareScanWorkflowId).toBe('wf-2');
    });
  });

  describe('the download gate', () => {
    /** A completed deal whose Final passed both scans: the buyer can download it. */
    async function owned() {
      const { dealId, fileId } = await delivered();
      workflows.set('wf-1', workflow('succeeded', [CLEAN, NOT_PICKLE]));
      await run();
      await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
      expect(await asBuyer(fileId)).not.toBeNull();
      expect(await listedForBuyer(dealId, fileId)).toMatchObject({ canDownload: true });
      return { dealId, fileId };
    }
    const setMalware = (fileId: number, status: string) =>
      q(
        `UPDATE "ServiceDealFile" SET "malwareScanStatus" = $2::"ServiceDealFileScanStatus" WHERE id = $1`,
        [fileId, status]
      );

    it.each(['Failed', 'Pending'])(
      'never gives the buyer a Final whose malware scan is %s, whatever its aggregate says',
      async (status) => {
        const { dealId, fileId } = await owned();
        await setMalware(fileId, status);
        expect((await fileRow(fileId)).scanStatus).toBe('Passed');
        expect(await asBuyer(fileId)).toBeNull();
        expect(await listedForBuyer(dealId, fileId)).toMatchObject({
          canDownload: false,
          fileName: null,
        });
        // The seller still can.
        expect(
          await files.resolveServiceDealFileDownload({
            servableLevels: 31,
            fileId,
            userId: SELLER,
            isModerator: false,
          })
        ).not.toBeNull();
      }
    );

    it('still gives the buyer a Final passed while the scan was off', async () => {
      const { dealId, fileId } = await owned();
      await setMalware(fileId, 'NotScanned');
      expect(await asBuyer(fileId)).not.toBeNull();
      expect(await listedForBuyer(dealId, fileId)).toMatchObject({ canDownload: true });
    });

    it('fails a Final left Pending past the give-up window, so it never unlocks for its owner', async () => {
      const { dealId, fileId } = await delivered();
      // Owned, so nothing but the scan stands between the buyer and the file.
      await q(
        `UPDATE "ServiceDeal" SET status = 'Completed', "completedAt" = now(), "releaseAt" = now() WHERE id = $1`,
        [dealId]
      );
      await age(fileId, 'malwareScanStartedAt', SERVICE_FINAL_SCAN_GIVE_UP_MS + 60_000);
      expect(await asBuyer(fileId)).toBeNull();
      await run();
      expect(await fileRow(fileId)).toMatchObject({
        scanStatus: 'Failed',
        malwareScanStatus: 'Failed',
      });
      expect(await asBuyer(fileId)).toBeNull();
      expect(await listedForBuyer(dealId, fileId)).toMatchObject({ canDownload: false });
    });
  });
});

describe('a video Final', () => {
  const probe = { video: vi.fn() };
  const CLIP = mp4Clip({ seconds: 10 });
  /** Serves the clip whole as version ver1, and its head bytes to a ranged read. */
  const serveClip = (etag = '"v1"', clip: Buffer = CLIP) =>
    s3.send.mockImplementation(async (command: { input: { Range?: string } }) =>
      command.input.Range
        ? body(clip.subarray(0, 16))
        : { ...body(clip), ETag: etag, VersionId: 'ver1' }
    );
  const videoFinal = async (limit: number, clip: Buffer = CLIP, name = 'clip.mp4') => {
    const dealId = await accepted();
    await q(`UPDATE "ServiceDeal" SET "maxNsfwLevel" = $1`, [limit]);
    const fileId = await final(dealId, name, clip);
    serveClip('"v1"', clip);
    expect(await unpack.unpackFinals({ probeVideo: probe.video })).toBe(1);
    return { dealId, fileId };
  };
  /** Settles the entry and the malware scan, then the Final. */
  const judged = async (fileId: number, level: number, flags = '') => {
    await verdict('Scanned', flags, level);
    await unpack.settleEntryScans();
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed' WHERE id = $1`, [fileId]);
    await unpack.settleFinals();
    return fileRow(fileId);
  };
  const completed = (dealId: number) =>
    q(
      `UPDATE "ServiceDeal" SET status = 'Completed', "completedAt" = now(), "releaseAt" = now() WHERE id = $1`,
      [dealId]
    );
  const download = (fileId: number, userId: number, servableLevels = 31) =>
    files.resolveServiceDealFileDownload({ fileId, userId, isModerator: false, servableLevels });

  beforeEach(() => {
    probe.video.mockResolvedValue({ width: 640, height: 360, duration: 10.1 });
  });

  it('never stamped and rated off this domain, is refused, with no link to the other domain', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    const listed = async () =>
      (
        await files.listServiceDealFiles({
          dealId,
          userId: SELLER,
          isModerator: false,
          servableLevels: 3,
        })
      ).find((row) => row.id === fileId);
    expect(await listed()).toMatchObject({ canDownload: false, downloadOffDomain: true });
    await q(
      `UPDATE "ServiceDealFile" SET "scannedEtag" = NULL, "scannedVersionId" = NULL WHERE id = $1`,
      [fileId]
    );
    expect(await listed()).toMatchObject({ canDownload: false });
    expect((await listed())?.downloadOffDomain).toBeUndefined();
  });

  it('once removed and never stamped, is refused to a CSAM reviewer, listed and downloaded alike', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    await q(`UPDATE "ServiceDealFile" SET "removedAt" = now() WHERE id = $1`, [fileId]);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    expect(await reviewerSees(dealId, fileId, 31)).toEqual({ listed: true, downloaded: true });
    await q(
      `UPDATE "ServiceDealFile" SET "scannedEtag" = NULL, "scannedVersionId" = NULL WHERE id = $1`,
      [fileId]
    );
    expect(await reviewerSees(dealId, fileId, 31)).toEqual({ listed: false, downloaded: false });
  });

  it('scans the whole video, as the version it will serve', async () => {
    const { fileId } = await videoFinal(4);
    expect(s3.uploadImageBufferToStore.mock.calls[0][0].equals(CLIP)).toBe(true);
    expect(images.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'video', mimeType: 'video/mp4', width: 640, height: 360 })
    );
    expect(
      await q(`SELECT "scannedEtag", "scannedVersionId" FROM "ServiceDealFile" WHERE id = $1`, [
        fileId,
      ])
    ).toEqual([{ scannedEtag: '"v1"', scannedVersionId: 'ver1' }]);
  });

  it('passes an R video on an R deal, which the buyer downloads after accepting', async () => {
    const { dealId, fileId } = await videoFinal(4);
    expect(await judged(fileId, 4)).toMatchObject({ scanStatus: 'Passed' });
    expect(await download(fileId, BUYER)).toBeNull();
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    expect(await download(fileId, BUYER)).toMatchObject({ versionId: 'ver1' });
  });

  it('serves no bytes but the scanned version, nor to a SFW domain or a stranger', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    // A versioned store: the scanned version, and a newer one written after the scan.
    s3.send.mockImplementation(async ({ input }: { input: { VersionId?: string } }) =>
      input.VersionId === 'ver1'
        ? { ETag: '"v1"', VersionId: 'ver1' }
        : { ETag: '"v2"', VersionId: 'ver2' }
    );
    const target = await download(fileId, BUYER);
    expect(target).toMatchObject({ versionId: 'ver1' });
    s3.getGetUrlByKey.mockResolvedValue({ url: 'https://signed' });
    await files.getServiceDealFileDownloadUrl(target!, {
      serviceDealFileAccess: async () => true,
    } as never);
    expect(s3.getGetUrlByKey).toHaveBeenCalledWith(
      target!.key,
      expect.objectContaining({ versionId: 'ver1' })
    );
    // The object was replaced after the scan.
    s3.send.mockResolvedValue({ ETag: '"v2"', VersionId: 'ver1' });
    expect(await download(fileId, BUYER)).toBeNull();
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver2' });
    expect(await download(fileId, BUYER)).toBeNull();
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    expect(await download(fileId, BUYER, 3)).toBeNull();
    expect(await download(fileId, 99)).toBeNull();
  });

  it('is listed as the download would serve it: off the domain, and unstamped', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    const listed = async (servableLevels: number) =>
      (
        await files.listServiceDealFiles({
          dealId,
          userId: BUYER,
          isModerator: false,
          servableLevels,
        })
      ).find((row) => row.id === fileId);
    expect(await listed(31)).toMatchObject({ canDownload: true });
    expect(await download(fileId, BUYER, 3)).toBeNull();
    expect(await listed(3)).toMatchObject({ canDownload: false, downloadOffDomain: true });
    await q(`UPDATE "ServiceDealFile" SET "scannedEtag" = NULL WHERE id = $1`, [fileId]);
    expect(await download(fileId, BUYER)).toBeNull();
    const unstamped = await listed(31);
    expect(unstamped).toMatchObject({ canDownload: false });
    expect(unstamped?.downloadOffDomain).toBeUndefined();
  });

  it('holds a moderator on the download route to the domain, and unscanned bytes to dispute review', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    const asModerator = (servableLevels: number, moderatorFetch = false) =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: 99,
        isModerator: true,
        moderatorFetch,
        servableLevels,
      });
    expect(await asModerator(3)).toBeNull();
    expect(await asModerator(31)).toMatchObject({ versionId: 'ver1' });
    await q(
      `UPDATE "ServiceDealFile" SET "scannedEtag" = NULL, "scannedVersionId" = NULL WHERE id = $1`,
      [fileId]
    );
    expect(await download(fileId, BUYER)).toBeNull();
    expect(await asModerator(31)).toBeNull();
    expect(await asModerator(31, true)).toMatchObject({ fileName: 'clip.mp4' });
  });

  it('lets dispute review open a video the scan blocked, and no one else', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    await q(`UPDATE "ServiceDealFileEntry" SET "nsfwLevel" = $2 WHERE "fileId" = $1`, [
      fileId,
      32, // NsfwLevel.Blocked
    ]);
    const asModerator = (moderatorFetch: boolean) =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: 99,
        isModerator: true,
        moderatorFetch,
        servableLevels: 31,
      });
    expect(await asModerator(true)).toMatchObject({ versionId: 'ver1' });
    expect(await asModerator(false)).toBeNull();
    expect(await download(fileId, BUYER, 31)).toBeNull();
  });

  it.each([
    ['blocked for CSAM', `"blockedFor" = 'CSAM'`],
    ['flagged as a minor', 'minor = true'],
  ])('serves a video %s to no one, dispute review included', async (_n, held) => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    const [{ id: imageId }] = await q<{ id: number }>(
      `INSERT INTO "Image" (url, "nsfwLevel") VALUES ('held', 32) RETURNING id`
    );
    expect(
      await q(
        `UPDATE "ServiceDealFileEntry" SET "imageId" = $2, "nsfwLevel" = 32 WHERE "fileId" = $1 RETURNING 1`,
        [fileId, imageId]
      )
    ).toHaveLength(1);
    const disputeReview = () =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: 99,
        isModerator: true,
        moderatorFetch: true,
        servableLevels: 31,
      });
    // The control: blocked for another reason, dispute review opens it.
    expect(await disputeReview()).toMatchObject({ versionId: 'ver1' });
    await q(`UPDATE "Image" SET ${held} WHERE id = $1`, [imageId]);
    expect(await disputeReview()).toBeNull();
  });

  it('keeps a blocked video from dispute review once its scan image is gone', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    const [{ id: imageId }] = await q<{ id: number }>(
      `INSERT INTO "Image" (url, "nsfwLevel") VALUES ('blocked', 32) RETURNING id`
    );
    await q(
      `UPDATE "ServiceDealFileEntry" SET "imageId" = $2, "nsfwLevel" = 32 WHERE "fileId" = $1`,
      [fileId, imageId]
    );
    const disputeReview = () =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: 99,
        isModerator: true,
        moderatorFetch: true,
        servableLevels: 31,
      });
    expect(await disputeReview()).toMatchObject({ versionId: 'ver1' });
    // Purged after its retention: nothing is left to show it was not held for CSAM or a minor.
    await q(`DELETE FROM "Image" WHERE id = $1`, [imageId]);
    expect(await disputeReview()).toBeNull();
  });

  it('gives a video not yet rated only to dispute review', async () => {
    const { fileId } = await videoFinal(4);
    s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
    const asModerator = (moderatorFetch: boolean) =>
      files.resolveServiceDealFileDownload({
        fileId,
        userId: 99,
        isModerator: true,
        moderatorFetch,
        servableLevels: 31,
      });
    expect(await asModerator(false)).toBeNull();
    expect(await asModerator(true)).toMatchObject({ versionId: 'ver1' });
  });

  describe("the dispute tool's list offers a download exactly when its download serves one", () => {
    const remove = (fileId: number) =>
      q(`UPDATE "ServiceDealFile" SET "removedAt" = now() WHERE id = $1`, [fileId]);

    it.each([false, true])('a video never stamped, removed: %s', async (removed) => {
      const { dealId, fileId } = await videoFinal(4);
      s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
      if (removed) await remove(fileId);
      expect(await callerSees(dealId, fileId, DISPUTE_TOOL)).toEqual({
        listed: true,
        downloaded: true,
      });
    });

    it.each([false, true])('a Final rated Blocked, removed: %s', async (removed) => {
      const { dealId, fileId } = await videoFinal(4);
      await judged(fileId, 4);
      await completed(dealId);
      s3.send.mockResolvedValue({ ETag: '"v1"', VersionId: 'ver1' });
      await q(`UPDATE "ServiceDealFileEntry" SET "nsfwLevel" = 32 WHERE "fileId" = $1`, [fileId]);
      if (removed) await remove(fileId);
      expect(await callerSees(dealId, fileId, DISPUTE_TOOL)).toEqual({
        listed: true,
        downloaded: true,
      });
    });
  });

  it.each([
    [11, null],
    [11.2, SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR],
  ])(
    'allows a second between stated and real length: %s s of samples under a 10 s header',
    async (seconds, failReason) => {
      probe.video.mockResolvedValue({ width: 640, height: 360, duration: 10 });
      const { fileId } = await videoFinal(4, mp4Clip({ seconds, headerSeconds: 10 }));
      expect((await fileRow(fileId)).failReason).toBe(failReason);
    }
  );

  it('reads a missing scanned version as a mismatch, and any other store failure as no answer', async () => {
    const { dealId, fileId } = await videoFinal(4);
    await judged(fileId, 4);
    await completed(dealId);
    s3.send.mockRejectedValue(
      Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } })
    );
    expect(await download(fileId, BUYER)).toBeNull();
    s3.send.mockRejectedValue(
      Object.assign(new Error('busy'), { $metadata: { httpStatusCode: 503 } })
    );
    await expect(download(fileId, BUYER)).rejects.toThrow('busy');
  });

  it("fails an R video on a PG-13 deal, saying it is rated above the deal's level", async () => {
    const { fileId } = await videoFinal(2);
    expect(await judged(fileId, 4)).toMatchObject({
      scanStatus: 'Failed',
      failReason: SERVICE_FINAL_OVER_LEVEL_REASON,
    });
  });

  it.each([
    ['a minor', ', minor = true'],
    ['a real person', ', poi = true'],
    ['one held for review', `, "needsReview" = 'csam'`],
  ])('fails a video flagged as %s', async (_n, flags) => {
    const { fileId } = await videoFinal(16);
    expect(await judged(fileId, 4, flags)).toMatchObject({ scanStatus: 'Failed' });
    expect((await entries(fileId))[0].failReason).toMatch(/rejected/);
  });

  it('refuses a video longer than site uploads allow, and drops its copy unscanned', async () => {
    const seconds = constants.mediaUpload.maxVideoDurationSeconds + 0.5;
    probe.video.mockResolvedValue({ width: 640, height: 360, duration: seconds });
    const { fileId } = await videoFinal(4, mp4Clip({ seconds }));
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: SERVICE_FINAL_VIDEO_TOO_LONG,
    });
    expect(images.createImage).not.toHaveBeenCalled();
    expect(s3.deleteObject).toHaveBeenCalledWith('image-store', 'scan-key-1', expect.anything());
  });

  it.each([
    ['an mp4', () => mp4Clip({ seconds: 60, headerSeconds: 20 }), 'clip.mp4'],
    [
      'a webm of unknown-size clusters',
      () => webmClip({ declared: 20, blocks: [0, 30, 60], unknownSize: true }),
      'clip.webm',
    ],
  ])('refuses %s whose header claims 20 s over 60 s of stream', async (_n, clip, name) => {
    // The orchestrator's probe reads the header, so it agrees with the claim.
    probe.video.mockResolvedValue({ width: 640, height: 360, duration: 20 });
    const { fileId } = await videoFinal(4, clip(), name);
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR,
    });
    expect(images.createImage).not.toHaveBeenCalled();
    expect(s3.deleteObject).toHaveBeenCalledWith('image-store', 'scan-key-1', expect.anything());
  });

  it('refuses as too long a video whose header claims a short length over a stream past the limit', async () => {
    probe.video.mockResolvedValue({ width: 640, height: 360, duration: 20 });
    const seconds = constants.mediaUpload.maxVideoDurationSeconds + 20;
    const { fileId } = await videoFinal(4, mp4Clip({ seconds, headerSeconds: 20 }));
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: SERVICE_FINAL_VIDEO_TOO_LONG,
    });
    expect(images.createImage).not.toHaveBeenCalled();
  });

  it('refuses a short video whose stated and real lengths disagree', async () => {
    const { fileId } = await videoFinal(4, mp4Clip({ seconds: 30, headerSeconds: 10 }));
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: SERVICE_FINAL_VIDEO_LENGTH_UNCLEAR,
    });
    expect(images.createImage).not.toHaveBeenCalled();
  });

  it('refuses a stored video over the size cap before reading it', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'clip.mp4', CLIP);
    await q(`UPDATE "ServiceDealFile" SET size = $1 WHERE id = $2`, [
      constants.mediaUpload.maxVideoFileSize + 1,
      fileId,
    ]);
    serveClip();
    await unpack.unpackFinals({ probeVideo: probe.video });
    expect((await fileRow(fileId)).failReason).toMatch(/too large/);
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('refuses, without retrying or copying, a video whose container cannot be read', async () => {
    const { fileId } = await videoFinal(4, MP4_BYTES());
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Failed',
      failReason: expect.stringMatching(/could not be read/),
    });
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
  });

  it('refuses a video whose length cannot be read', async () => {
    probe.video.mockResolvedValue({ width: 640, height: 360 });
    const { fileId } = await videoFinal(4);
    expect((await fileRow(fileId)).failReason).toMatch(/could not be read/);
    expect(images.createImage).not.toHaveBeenCalled();
  });

  it('retries, rather than refuses, a video the probe gave no answer on', async () => {
    probe.video.mockResolvedValue(null);
    const dealId = await accepted();
    const fileId = await final(dealId, 'clip.mp4', CLIP);
    serveClip();
    expect(await unpack.unpackFinals({ probeVideo: probe.video })).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Pending', failReason: null });
  });

  it('takes a video of exactly the site upload length, and a .webm as video/webm', async () => {
    const max = constants.mediaUpload.maxVideoDurationSeconds;
    probe.video.mockResolvedValue({ width: 640, height: 360, duration: max });
    const clip = webmClip({ declared: max, blocks: [0, max / 2, max - 0.04] });
    const dealId = await accepted();
    const fileId = await final(dealId, 'clip.webm', clip);
    serveClip('"v1"', clip);
    await unpack.unpackFinals({ probeVideo: probe.video });
    expect((await fileRow(fileId)).failReason).toBeNull();
    expect(images.createImage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'video', mimeType: 'video/webm' })
    );
  });

  it('reuses its scan copy and Image after a crash, never scanning twice', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'clip.mp4', CLIP);
    serveClip();
    // The first run dies after the Image is made, before it is recorded on the entry.
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE id = $1`, [fileId]);
    images.createImage.mockImplementationOnce(async ({ url }: { url: string }) => {
      await q(`INSERT INTO "Image" (url) VALUES ($1)`, [url]);
      throw new Error('worker died');
    });
    expect(await unpack.unpackFinals({ probeVideo: probe.video })).toBe(0);
    await ageClaim(fileId, 60 * 60_000);
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = NULL WHERE id = $1`, [fileId]);
    expect(await unpack.unpackFinals({ probeVideo: probe.video })).toBe(1);
    expect(s3.uploadImageBufferToStore).toHaveBeenCalledOnce();
    expect(images.createImage).toHaveBeenCalledOnce();
    expect((await entries(fileId))[0].imageId).not.toBeNull();
  });
});
