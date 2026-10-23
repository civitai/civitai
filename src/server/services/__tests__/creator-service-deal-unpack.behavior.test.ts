import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  PNG_BYTES,
  symlinkAttributes,
  type FixtureEntry,
} from '~/server/utils/__tests__/zip-fixture';

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
const scan = await import('~/server/services/creator-service-deal-file-scan');
const orchestrator = await import('@civitai/orchestration-client');
const { PreviewRejectedError } = await import('~/server/utils/service-deal-preview');
const {
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
    TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'None', 'Active', now());
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
    // A stop is not a failure: nothing was logged as an error.
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
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
    ['a video', () => [{ name: 'clip.mp4', data: MP4_BYTES() }], /Video/],
    ['a video called something else', () => [{ name: 'a.dat', data: MP4_BYTES() }], /Video/],
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
      return body(command.input.Range ? whole.subarray(0, 16) : whole);
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
    ['a video called notes.txt', MP4_BYTES(), /Video/],
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

  it('leaves plain documents without entries, and does not sniff a model file', async () => {
    const dealId = await accepted();
    const doc = await final(dealId, 'brief.txt', Buffer.from('just some words in a text file'));
    serveHeads();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(await entries(doc)).toEqual([]);
    expect((await fileRow(doc)).unpackedAt).not.toBeNull();
    // A model file may begin with any bytes, so it is not sniffed.
    const model = await final(dealId, 'm.pt', PK);
    s3.send.mockClear();
    expect(await unpack.unpackFinals()).toBe(1);
    expect(s3.send).not.toHaveBeenCalled();
    expect(await fileRow(model)).toMatchObject({ scanStatus: 'Pending' });
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
    expect(images.deleteImageById).not.toHaveBeenCalled();
    const rows = await q<{
      fileId: number | null;
      dealId: number;
      imageId: number;
      scanKey: string;
    }>(`SELECT "fileId", "dealId", "imageId", "scanKey" FROM "ServiceDealFileEntry"`);
    expect(rows).toEqual([{ fileId: null, dealId, imageId: 1, scanKey: 'scan-key-1' }]);
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
    ['rated above the limit', 'Scanned', '', 3],
    ['rated far above the limit', 'Scanned', '', 16],
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
    images.deleteImageById.mockRejectedValueOnce(new Error('store down'));
    expect(await unpack.deleteEntryScanCopies()).toBe(0);
    expect((await entries(fileId))[0].imageId).toBe(1);
    expect(await unpack.deleteEntryScanCopies()).toBe(1);
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
      await threeImages();
      expect(images.deleteImageById).toHaveBeenCalledTimes(1);
      expect(images.deleteImageById).toHaveBeenCalledWith({ id: 1, updatePost: false });
      expect(await q(`SELECT id FROM "Image" ORDER BY id`)).toEqual([{ id: 2 }, { id: 3 }]);
      const rows = await orphans();
      expect(rows.map((r) => [r.scanStatus, r.imageId, r.fileId, r.dealId])).toEqual([
        ['Failed', 2, null, 1],
        ['Pending', 3, null, 1],
      ]);
    });

    it('removes the rows of images that were never submitted', async () => {
      const dealId = await accepted();
      const fileId = await zipFinal(dealId, [{ name: 'a.png', data: IMAGE_A }]);
      await q(
        `INSERT INTO "ServiceDealFileEntry" ("fileId", "dealId", "entryIndex", "path", "size") VALUES ($1, $2, 0, 'a.png', 1)`,
        [fileId, dealId]
      );
      await files.deleteServiceDealFile({ fileId, userId: SELLER });
      expect(await q(`SELECT 1 FROM "ServiceDealFileEntry"`)).toEqual([]);
    });

    it('still judges the image whose scan finishes later, and drops it once it passes', async () => {
      await threeImages();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 1 WHERE id = 3`);
      expect((await unpack.settleEntryScans()).passed).toBe(1);
      expect(await unpack.deleteEntryScanCopies()).toBe(1);
      expect(await q(`SELECT id FROM "Image"`)).toEqual([{ id: 2 }]);
      // Its row goes with its copy; the rejected image's stays.
      expect((await orphans()).map((r) => r.imageId)).toEqual([2]);
    });

    it("rejects the image that comes back above the deal's limit, and keeps its copy", async () => {
      await threeImages();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 4 WHERE id = 3`);
      await unpack.settleEntryScans();
      expect(await unpack.deleteEntryScanCopies()).toBe(0);
      expect((await orphans()).map((r) => [r.scanStatus, r.imageId])).toEqual([
        ['Failed', 2],
        ['Failed', 3],
      ]);
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
      json: async () => ({ id: `blob-${++blobs}.bin` }),
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
    files.resolveServiceDealFileDownload({ fileId, userId: BUYER, isModerator: false });
  const listedForBuyer = async (dealId: number, fileId: number) =>
    (await files.listServiceDealFiles({ dealId, userId: BUYER, isModerator: false })).find(
      (row) => row.id === fileId
    );

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
      ['pickle parse error', workflow('succeeded', [CLEAN, pickle('parseError')]), 'Retry'],
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
    await delivered('weights.safetensors', Buffer.from('not really weights'));
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
          await files.resolveServiceDealFileDownload({ fileId, userId: SELLER, isModerator: false })
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
