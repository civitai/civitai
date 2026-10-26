import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import * as yauzl from 'yauzl';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVICES_TERMS_VERSION } from '~/shared/constants/creator-service-terms.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as ChatService from '~/server/services/chat.service';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as CreatorShop from '~/server/services/creator-shop.service';
import type * as ZipModule from '~/server/utils/service-deal-zip';
import {
  buildZip,
  MP4_BYTES,
  PNG_BYTES,
  type FixtureEntry,
  type FixtureOptions,
} from '~/server/utils/__tests__/zip-fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Building the archive a buyer downloads from a Final that has been unpacked, run against the real
 * migrations on an in-process Postgres. Faked: storage, the image service, the scan-copy builder, Buzz and chat.
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

/** The multipart upload, collecting what is written into the fake bucket. */
const uploads = vi.hoisted(() => ({
  started: 0,
  aborted: 0,
  failNext: false,
  failEarly: false,
  corrupt: null as null | ((built: Buffer) => Buffer),
  beforeDone: null as null | (() => Promise<void>),
}));
// `default` mirrors the named export: the package is pre-bundled for CJS interop, so consumers
// resolve through `default`.
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {
    constructor(
      private readonly options: {
        params: { Key: string; Body: AsyncIterable<Buffer> };
      }
    ) {
      uploads.started++;
    }
    async done() {
      if (uploads.failEarly) {
        // Stops reading the archive as it is written, as a failed part upload does.
        uploads.failEarly = false;
        throw new Error('upload failed early');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of this.options.params.Body) chunks.push(chunk);
      if (uploads.failNext) {
        uploads.failNext = false;
        throw new Error('upload failed');
      }
      if (uploads.beforeDone) {
        const hook = uploads.beforeDone;
        uploads.beforeDone = null;
        await hook();
      }
      const built = Buffer.concat(chunks);
      bucket.objects.set(this.options.params.Key, uploads.corrupt ? uploads.corrupt(built) : built);
    }
    async abort() {
      uploads.aborted++;
    }
  };
  return { Upload, default: { Upload } };
});

const scanSeam = vi.hoisted(() => ({
  submitFinalScan: vi.fn(async () => 'Pending' as const),
  isFinalsMalwareScanOn: vi.fn(async () => true),
}));
vi.mock('~/server/services/creator-service-deal-file-scan', () => ({
  submitFinalScan: scanSeam.submitFinalScan,
  isFinalsMalwareScanOn: scanSeam.isFinalsMalwareScanOn,
}));

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
const repack = await import('~/server/services/creator-service-deal-repack.service');
const { SERVICE_FINAL_MAX_BYTES, SERVICE_UNPACK_STALE_MS } = await import(
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
};
const fileRow = async (id: number) =>
  (await q<FileRecord>(`SELECT * FROM "ServiceDealFile" WHERE id = $1`, [id]))[0];
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
  s3.headObject.mockImplementation(async (_bucket: string, key: string) => ({
    status: 'present',
    size: bucket.objects.get(key)?.byteLength ?? content.byteLength,
  }));
  s3.send.mockResolvedValue(body(content.subarray(0, 64)));
  await files.completeServiceDealUpload({ fileId, userId: SELLER });
  const row = await fileRow(fileId);
  expect(row.status).toBe('Ready');
  expect(row.s3Key).toMatch(/^service-deals\/files\//);
  bucket.objects.set(row.s3Key, content);
  return fileId;
}

const IMAGE_A = PNG_BYTES(100);
const SCAN_COPY = (n: number) => Buffer.from(`scan-copy-${n}`);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp, "deletedAt" timestamp, muted boolean NOT NULL DEFAULT false);
    CREATE TYPE "UserEngagementType" AS ENUM ('Hide', 'Follow', 'Block');
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
    CREATE TABLE "Report" (id serial PRIMARY KEY);
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
  uploads.started = 0;
  uploads.aborted = 0;
  uploads.failNext = false;
  uploads.failEarly = false;
  uploads.corrupt = null;
  uploads.beforeDone = null;
  bucket.zipReads.length = 0;
  s3.getPutUrl.mockImplementation(async (key: string) => ({ url: `https://put/${key}` }));
  s3.deleteObject.mockImplementation(async (_bucket: string, key: string) => {
    bucket.objects.delete(key);
  });
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
    TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'None', 'Active', now());
  `);
});

/** Reads an archive with yauzl directly (not through the app's reader), checking its sizes honestly. */
const readBack = (buffer: Buffer) =>
  new Promise<{ name: string; data: Buffer }[]>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) return reject(error);
      const found: { name: string; data: Buffer }[] = [];
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(found));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            found.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  });

const ageClaim = (fileId: number, ms: number) =>
  q(
    `UPDATE "ServiceDealFile" SET "processingAt" = now() - ($2::int * interval '1 millisecond') WHERE id = $1`,
    [fileId, ms]
  );

/** A zip Final that has been through the unpack step. */
async function unpackedZip(items: FixtureEntry[], options?: FixtureOptions) {
  const dealId = await accepted();
  const fileId = await final(dealId, 'result.zip', buildZip(items, options));
  expect(await unpack.unpackFinals()).toBe(1);
  expect((await fileRow(fileId)).unpackedAt).not.toBeNull();
  return { dealId, fileId };
}

const TEXT = (s: string) => Buffer.from(s.repeat(10));

describe('building the archive a buyer downloads', () => {
  it('copies exactly the checked files into a new archive, and leaves the original alone', async () => {
    const items = [
      { name: 'docs/a.txt', data: TEXT('alpha ') },
      { name: 'b.dat', data: TEXT('beta ') },
      { name: 'img/c.png', data: IMAGE_A },
    ];
    const { fileId } = await unpackedZip(items);
    const original = bucket.objects.get((await fileRow(fileId)).s3Key)!;

    expect(await repack.repackFinals()).toBe(1);

    const file = await fileRow(fileId);
    expect(file.deliveryKey).toMatch(/^service-deals\/delivered\/1\/0\/[0-9a-f-]{36}$/);
    expect(file.deliveryKey).not.toBe(file.s3Key);
    const built = bucket.objects.get(file.deliveryKey!)!;
    expect(file.deliverySize).toBe(built.byteLength);
    expect(file.repackedAt).not.toBeNull();
    expect(file.processingAt).toBeNull();
    expect(file.scanStatus).toBe('Pending');
    expect(await readBack(built)).toEqual(items.map((i) => ({ name: i.name, data: i.data })));
    // The seller's archive is untouched, and is not what was built.
    expect(bucket.objects.get(file.s3Key)).toBe(original);
    expect(built.equals(original)).toBe(false);
  });

  it('hands the delivery file, not the upload, to the malware scan', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await repack.repackFinals();
    const file = await fileRow(fileId);
    expect(scanSeam.submitFinalScan).toHaveBeenCalledTimes(1);
    expect(scanSeam.submitFinalScan).toHaveBeenCalledWith(
      expect.objectContaining({ id: fileId, s3Key: file.deliveryKey, size: file.deliverySize })
    );
  });

  it('with the finals malware scan off, records the step as skipped instead', async () => {
    scanSeam.isFinalsMalwareScanOn.mockResolvedValueOnce(false);
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await repack.repackFinals();
    expect(scanSeam.submitFinalScan).not.toHaveBeenCalled();
    expect(await fileRow(fileId)).toMatchObject({
      malwareScanStatus: 'NotScanned',
      scanStatus: 'Pending',
    });
  });

  it('writes only regular files, in the original order, under tidied names', async () => {
    const items = [
      { name: 'folder/' },
      { name: './tidy//name.txt', data: TEXT('one ') },
      { name: 'folder/two.txt', data: TEXT('two ') },
    ];
    const { fileId } = await unpackedZip(items);
    await repack.repackFinals();
    const built = bucket.objects.get((await fileRow(fileId)).deliveryKey!)!;
    expect((await readBack(built)).map((e) => e.name)).toEqual(['tidy/name.txt', 'folder/two.txt']);
  });

  it('carries nothing over from the original but the bytes of the files it checked', async () => {
    const items = [
      { name: 'a.txt', data: TEXT('alpha '), localName: 'other-name-a.txt' },
      { name: 'b.txt', data: TEXT('beta ') },
      { name: 'extra-entry.txt', data: TEXT('hidden ') },
    ];
    const { fileId } = await unpackedZip(items, { declaredEntryCount: 2 });
    await repack.repackFinals();
    const built = bucket.objects.get((await fileRow(fileId)).deliveryKey!)!;
    expect(await readBack(built)).toEqual([
      { name: 'a.txt', data: items[0].data },
      { name: 'b.txt', data: items[1].data },
    ]);
    for (const leftover of ['other-name-a', 'extra-entry', 'hidden '])
      expect(built.includes(Buffer.from(leftover))).toBe(false);
  });

  it("refuses two files that would be one on a buyer's disk", async () => {
    const { fileId } = await unpackedZip([
      { name: 'Report.txt', data: TEXT('one ') },
      { name: 'report.TXT', data: TEXT('two ') },
    ]);
    expect(await repack.repackFinals()).toBe(1);
    const file = await fileRow(fileId);
    expect(file).toMatchObject({ scanStatus: 'Failed', deliveryKey: null, repackedAt: null });
    expect(file.failReason).toMatch(/same name/);
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });

  it('puts the original through the same checks again before copying anything', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    bucket.objects.set(
      (await fileRow(fileId)).s3Key,
      buildZip([{ name: 'inner.zip', data: TEXT('x ') }])
    );
    expect(await repack.repackFinals()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Failed', deliveryKey: null });
    expect((await fileRow(fileId)).failReason).toMatch(/nested/);
    expect(uploads.started).toBe(0);
  });

  it('holds a delivered deal for the moderators when its archive turns out to be refused', async () => {
    const { dealId, fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    bucket.objects.set(
      (await fileRow(fileId)).s3Key,
      buildZip([{ name: 'c.mp4', data: MP4_BYTES() }])
    );
    await repack.repackFinals();
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
  });
});

describe('which files are rebuilt', () => {
  const notClaimed = async (fileId: number, change: string) => {
    await q(change.replace('$id', String(fileId)));
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
    expect(uploads.started).toBe(0);
  };

  it.each([
    ['not unpacked yet', `UPDATE "ServiceDealFile" SET "unpackedAt" = NULL WHERE id = $id`],
    ['already rebuilt', `UPDATE "ServiceDealFile" SET "repackedAt" = now() WHERE id = $id`],
    ['refused', `UPDATE "ServiceDealFile" SET "failReason" = 'no' WHERE id = $id`],
    ['already failed', `UPDATE "ServiceDealFile" SET "scanStatus" = 'Failed' WHERE id = $id`],
    ['held by a run', `UPDATE "ServiceDealFile" SET "processingAt" = now() WHERE id = $id`],
    ['not a Final', `UPDATE "ServiceDealFile" SET kind = 'Preview' WHERE id = $id`],
    ['not ready', `UPDATE "ServiceDealFile" SET status = 'Failed' WHERE id = $id`],
    ['not a zip', `UPDATE "ServiceDealFile" SET "fileName" = 'notes.txt' WHERE id = $id`],
  ])('does not take a file that is %s', async (_label, change) => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await notClaimed(fileId, change);
  });

  it('takes a file whose claim has gone stale', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await q(`UPDATE "ServiceDealFile" SET "processingAt" = now() WHERE id = $1`, [fileId]);
    expect(await repack.repackFinals()).toBe(0);
    await ageClaim(fileId, SERVICE_UNPACK_STALE_MS + 60_000);
    expect(await repack.repackFinals()).toBe(1);
  });

  it('does nothing and gives the claim back when the job is told to stop', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    expect(await repack.repackFinals({ shouldStop: () => true })).toBe(0);
    expect(uploads.started).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ processingAt: null, deliveryKey: null });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
    expect(await repack.repackFinals()).toBe(1);
  });

  it('leaves a file that is not an archive as it was uploaded, ready for its scan at once', async () => {
    const dealId = await accepted();
    const fileId = await final(dealId, 'notes.txt', Buffer.from('plain words in a text file'));
    s3.send.mockResolvedValue(body(Buffer.from('plain words in a text file')));
    expect(await unpack.unpackFinals()).toBe(1);
    const file = await fileRow(fileId);
    expect(file.repackedAt).not.toBeNull();
    expect(file.deliveryKey).toBeNull();
    expect(scanSeam.submitFinalScan).toHaveBeenCalledWith(
      expect.objectContaining({ id: fileId, s3Key: file.s3Key })
    );
    expect(await repack.repackFinals()).toBe(0);
  });
});

describe('what the read-back insists on', () => {
  const sameBytes = TEXT('alpha ');

  it('does not accept an archive whose files have other names', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: sameBytes }]);
    uploads.corrupt = () => buildZip([{ name: 'renamed.txt', data: sameBytes }]);
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
  });

  it('does not accept an archive with a file more than it was built from', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: sameBytes }]);
    uploads.corrupt = () =>
      buildZip([
        { name: 'a.txt', data: sameBytes },
        { name: 'extra.txt', data: Buffer.alloc(0) },
      ]);
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
  });

  it('does not accept an archive that is missing a file with nothing in it', async () => {
    const { fileId } = await unpackedZip([
      { name: 'a.txt', data: sameBytes },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]);
    uploads.corrupt = () => buildZip([{ name: 'a.txt', data: sameBytes }]);
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
  });

  it('does not accept an archive it cannot find again', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: sameBytes }]);
    s3.headObject.mockImplementation(async (_bucket: string, key: string) =>
      key.startsWith('service-deals/delivered/')
        ? { status: 'absent' }
        : { status: 'present', size: 1000 }
    );
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
  });

  it('stamps every file with the same fixed time', async () => {
    const { fileId } = await unpackedZip([
      { name: 'a.txt', data: sameBytes },
      { name: 'b.txt', data: TEXT('beta ') },
    ]);
    await repack.repackFinals();
    const built = bucket.objects.get((await fileRow(fileId)).deliveryKey!)!;
    const stamps = await new Promise<number[]>((resolve, reject) => {
      yauzl.fromBuffer(built, { lazyEntries: true }, (error, zipfile) => {
        if (error || !zipfile) return reject(error);
        const years: number[] = [];
        zipfile.on('end', () => resolve(years));
        zipfile.on('entry', (entry: yauzl.Entry) => {
          years.push(entry.getLastModDate().getFullYear());
          zipfile.readEntry();
        });
        zipfile.readEntry();
      });
    });
    expect(stamps).toEqual([2020, 2020]);
  });
});

describe('when the file changes while the archive is built', () => {
  it('leaves a file that was built by another run alone, and removes its own archive', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    uploads.beforeDone = async () => {
      await q(
        `UPDATE "ServiceDealFile" SET "repackedAt" = now(), "deliveryKey" = 'service-deals/delivered/other' WHERE id = $1`,
        [fileId]
      );
    };
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBe('service-deals/delivered/other');
    expect(scanSeam.submitFinalScan).not.toHaveBeenCalled();
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });

  it('does not attach an archive to a file that has failed in the meantime', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    uploads.beforeDone = async () => {
      await q(`UPDATE "ServiceDealFile" SET "scanStatus" = 'Failed' WHERE id = $1`, [fileId]);
    };
    expect(await repack.repackFinals()).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ deliveryKey: null, repackedAt: null });
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });

  it('stops between files when told to, and removes what it had written', async () => {
    const { fileId } = await unpackedZip([
      { name: 'a.txt', data: TEXT('alpha ') },
      { name: 'b.txt', data: TEXT('beta ') },
    ]);
    // Two checks while judging, one before each file is copied: the fourth stops the second.
    let calls = 0;
    expect(await repack.repackFinals({ shouldStop: () => ++calls === 4 })).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ deliveryKey: null, processingAt: null });
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });
});

describe('when the build goes wrong', () => {
  it('tries again later, leaves nothing behind, and lets the other files go first', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    uploads.failNext = true;
    expect(await repack.repackFinals()).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({
      deliveryKey: null,
      repackedAt: null,
      failReason: null,
    });
    expect(uploads.aborted).toBeGreaterThan(0);
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
    expect(await repack.repackFinals()).toBe(0);
    await ageClaim(fileId, SERVICE_UNPACK_STALE_MS + 60_000);
    expect(await repack.repackFinals()).toBe(1);
    expect((await fileRow(fileId)).deliveryKey).not.toBeNull();
  });

  it('does not accept an archive that does not hold what it was built from', async () => {
    const { fileId } = await unpackedZip([
      { name: 'a.txt', data: TEXT('alpha ') },
      { name: 'b.txt', data: TEXT('beta ') },
    ]);
    uploads.corrupt = () => buildZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    expect(await repack.repackFinals()).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ deliveryKey: null, repackedAt: null });
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });

  it('does not accept an archive whose files differ from the ones it copied', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    uploads.corrupt = () => buildZip([{ name: 'a.txt', data: TEXT('different ') }]);
    expect(await repack.repackFinals()).toBe(0);
    expect((await fileRow(fileId)).deliveryKey).toBeNull();
  });

  it('removes the archive it built when the file was deleted while it worked', async () => {
    const { dealId, fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    uploads.beforeDone = async () => {
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
    };
    expect(await repack.repackFinals()).toBe(0);
    expect(dealId).toBe(1);
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });

  it('removes the archive when the file is deleted afterwards', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await repack.repackFinals();
    const key = (await fileRow(fileId)).deliveryKey!;
    await files.deleteServiceDealFile({ fileId, userId: SELLER });
    expect(s3.deleteObject).toHaveBeenCalledWith('bucket', key);
  });
});

describe('after the archive is built', () => {
  it('keeps the archive when the hand-off to the scan fails', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    scanSeam.submitFinalScan.mockRejectedValueOnce(new Error('scanner down'));
    s3.deleteObject.mockClear();
    expect(await repack.repackFinals()).toBe(1);
    const file = await fileRow(fileId);
    expect(file.deliveryKey).not.toBeNull();
    expect(file.repackedAt).not.toBeNull();
    expect(bucket.objects.has(file.deliveryKey!)).toBe(true);
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });
});

describe('a build that cannot finish', () => {
  it('does not wait for ever on an upload that has stopped reading', async () => {
    // Incompressible and bigger than the stream's buffer, so an unread archive would stall the copy.
    const big = randomBytes(3 * 1024 * 1024);
    const { fileId } = await unpackedZip([{ name: 'big.dat', data: big }]);
    uploads.failEarly = true;
    expect(await repack.repackFinals()).toBe(0);
    expect(await fileRow(fileId)).toMatchObject({ deliveryKey: null, repackedAt: null });
  });

  it('gives up on a file that is still not built after a long time, and fails it', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    await q(
      `UPDATE "ServiceDealFile" SET "unpackedAt" = now() - interval '7 hours' WHERE id = $1`,
      [fileId]
    );
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 1, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Failed');
  });

  it('does not give up on a file that was built in time', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await repack.repackFinals();
    await q(
      `UPDATE "ServiceDealFile" SET "unpackedAt" = now() - interval '7 hours' WHERE id = $1`,
      [fileId]
    );
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect((await fileRow(fileId)).scanStatus).toBe('Pending');
  });
});

describe('what the built archive may hold', () => {
  it('accepts a file the seller stored uncompressed that compresses far better than allowed', async () => {
    const zeros = Buffer.alloc(3 * 1024 * 1024);
    const { fileId } = await unpackedZip([{ name: 'zeros.dat', data: zeros, method: 'store' }]);
    expect(await repack.repackFinals()).toBe(1);
    const file = await fileRow(fileId);
    expect(file.failReason).toBeNull();
    const built = bucket.objects.get(file.deliveryKey!)!;
    expect(built.byteLength).toBeLessThan(zeros.byteLength / 100);
    expect((await readBack(built))[0].data.equals(zeros)).toBe(true);
  });
});

describe('an archive that came out too large to deliver', () => {
  it('accepts one exactly as large as the size column can hold, and refuses one byte more', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    expect(SERVICE_FINAL_MAX_BYTES).toBe(2 ** 31 - 1);
    s3.headObject.mockImplementation(async (_bucket: string, key: string) => ({
      status: 'present',
      size: key.startsWith('service-deals/delivered/') ? SERVICE_FINAL_MAX_BYTES : 1000,
    }));
    expect(await repack.repackFinals()).toBe(1);
    expect((await fileRow(fileId)).deliverySize).toBe(2 ** 31 - 1);
  });

  it('is refused with a reason, not retried for ever', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    s3.headObject.mockImplementation(async (_bucket: string, key: string) => ({
      status: 'present',
      size: key.startsWith('service-deals/delivered/') ? 2 ** 31 : 1000,
    }));
    expect(await repack.repackFinals()).toBe(1);
    const file = await fileRow(fileId);
    expect(file).toMatchObject({ scanStatus: 'Failed', deliveryKey: null });
    expect(file.failReason).toMatch(/too large/);
    expect([...bucket.objects.keys()].some((k) => k.startsWith('service-deals/delivered/'))).toBe(
      false
    );
  });
});

describe('what a pass now needs', () => {
  it('does not pass a zip until its archive is built, then passes with the malware scan', async () => {
    const { fileId } = await unpackedZip([{ name: 'a.txt', data: TEXT('alpha ') }]);
    await q(`UPDATE "ServiceDealFile" SET "malwareScanStatus" = 'Passed' WHERE id = $1`, [fileId]);
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 0, finalsPassed: 0 });
    expect(await files.recordFinalScanResult({ fileId, verdict: 'Passed' })).toEqual({
      recorded: false,
      held: false,
    });
    await repack.repackFinals();
    expect(await unpack.settleFinals()).toEqual({ finalsFailed: 0, finalsPassed: 1 });
    expect((await fileRow(fileId)).scanStatus).toBe('Passed');
  });
});
