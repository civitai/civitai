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

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Delivery files for a Creator Services deal, run against the real P0 migration plus the delivery
 * migration on an in-process Postgres. Faked: storage, the image service, the preview builder,
 * Buzz and chat. Every authorisation, count, state and visibility rule is the production SQL.
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

const images = vi.hoisted(() => ({ createImage: vi.fn(), deleteImageById: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  createImage: images.createImage,
  deleteImageById: images.deleteImageById,
}));

const preview = vi.hoisted(() => ({ build: vi.fn(), scanCopy: vi.fn() }));
vi.mock('~/server/utils/service-deal-preview', () => ({
  buildWatermarkedPreview: preview.build,
  buildScanCopy: preview.scanCopy,
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
const { PreviewRejectedError } = await import('~/server/utils/service-deal-preview');
const { SERVICE_PREVIEW_MAX_FILES, SERVICE_FINAL_MAX_FILES } = await import(
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
  '20261206120000_creator_service_deal_file_access',
].map((name) =>
  join(process.cwd(), `packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`)
);

const SELLER = 1;
const BUYER = 2;
const STRANGER = 3;
const MOD = 4;

const q = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  (await holder.db.query<T>(sql, params)).rows;

type FileRecord = {
  dealId: number;
  round: number;
  kind: string;
  s3Key: string;
  fileName: string;
  status: string;
  scanStatus: string;
  failReason: string | null;
  imageId: number | null;
  scanKey: string | null;
  watermarkedKey: string | null;
  nsfwLevel: number | null;
  processingAt: Date | null;
};

const fileRow = async (id: number) =>
  (await q<FileRecord>(`SELECT * FROM "ServiceDealFile" WHERE id = $1`, [id]))[0];

const charged = { transactionIds: [], totalAmount: 500, transactionCount: 1 };

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
const ENCRYPTED_ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x01, 0x00, 0x08, 0x00]);
const body = (bytes: Buffer) => ({ Body: { transformToByteArray: async () => bytes } });

/** A deal in Accepted, with the offering's preview kind. */
async function accepted(previewKind = 'Image') {
  await q(`UPDATE "ServiceOffering" SET "previewKind" = $1::"ServicePreviewKind"`, [previewKind]);
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

const upload = (dealId: number, over: Record<string, unknown> = {}) =>
  files.requestServiceDealUpload({
    dealId,
    userId: SELLER,
    kind: 'Final',
    fileName: 'result.zip',
    mimeType: 'application/zip',
    size: 1000,
    ...over,
  } as Parameters<typeof files.requestServiceDealUpload>[0]);

/** Uploads and confirms a file; the bucket reports the declared size. */
async function uploaded(dealId: number, over: Record<string, unknown> = {}) {
  const { fileId } = await upload(dealId, over);
  s3.headObject.mockResolvedValue({ status: 'present', size: (over.size as number) ?? 1000 });
  s3.send.mockResolvedValue(body(ZIP));
  await files.completeServiceDealUpload({ fileId, userId: SELLER });
  // The unpack job's mark, set by hand: a delivery waits for it (see the unpack behaviour tests).
  if (over.kind !== 'Preview' && over.unpacked !== false)
    await q(`UPDATE "ServiceDealFile" SET "unpackedAt" = now() WHERE id = $1`, [fileId]);
  return fileId;
}

const readyPreview = async (dealId: number) => {
  const fileId = await uploaded(dealId, {
    kind: 'Preview',
    fileName: 'p.png',
    mimeType: 'image/png',
    size: 500,
  });
  await q(
    `UPDATE "ServiceDealFile" SET status = 'Ready', "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
    [fileId]
  );
  return fileId;
};

const list = (dealId: number, userId: number, isModerator = false) =>
  files.listServiceDealFiles({ dealId, userId, isModerator });

const download = (fileId: number, userId: number, isModerator = false) =>
  files.resolveServiceDealFileDownload({ fileId, userId, isModerator });

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
  for (const fn of [...Object.values(buzz), ...Object.values(s3), preview.build]) fn.mockReset();
  s3.getPutUrl.mockImplementation(async (key: string) => ({ url: `https://put/${key}` }));
  s3.deleteObject.mockResolvedValue(undefined);
  s3.getGetUrlByKey.mockImplementation(async (key: string) => ({ url: `https://get/${key}` }));
  chat.upsertDealChat.mockResolvedValue({ id: 77 });
  chat.createMessage.mockResolvedValue({});
  shop.assertCreatorShopVisible.mockResolvedValue([]);
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([]);
  await holder.db.exec(`
    TRUNCATE "ServiceDealFileAccess", "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "ServiceOfferingReport", "ServiceOffering", "UserEngagement", "Image" RESTART IDENTITY;
    DELETE FROM "User";
    INSERT INTO "User" (id) VALUES (${SELLER}), (${BUYER}), (${STRANGER}), (${MOD});
    INSERT INTO "ServiceOffering" ("sellerId", title, description, price, "deliveryDays", "revisionsIncluded", "previewKind", status, "updatedAt")
      VALUES (${SELLER}, 'Cat portraits', 'desc', 500, 3, 1, 'Image', 'Active', now());
  `);
});

describe('requesting an upload', () => {
  it('lets the seller of a deal being worked mint a key it chose itself', async () => {
    const dealId = await accepted();
    const result = await upload(dealId, { fileName: '../../etc/passwd.zip' });
    const row = await fileRow(result.fileId);
    expect(row).toMatchObject({
      dealId,
      round: 0,
      kind: 'Final',
      status: 'Uploading',
      scanStatus: 'Pending',
      fileName: 'passwd.zip',
    });
    // The key is built from ids and a uuid, never from the typed name.
    expect(row.s3Key).toMatch(
      new RegExp(`^service-deals/uploads/${dealId}/0/final/[0-9a-f-]{36}$`)
    );
    expect(result.uploadUrl).toBe(`https://put/${row.s3Key}`);
  });

  it.each([
    ['the buyer', BUYER],
    ['a stranger', STRANGER],
    ['a moderator', MOD],
  ])('answers %s with not-found and writes nothing', async (_who, userId) => {
    const dealId = await accepted();
    await expect(upload(dealId, { userId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toEqual([]);
  });

  it('refuses, for the seller too, once the deal has left the work', async () => {
    // Real transitions, so every state is reached the way production reaches it.
    const states: Record<string, () => Promise<number>> = {
      Requested: async () => {
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
        return id;
      },
      Delivered: async () => {
        const id = await accepted('None');
        await uploaded(id);
        await files.deliverServiceDeal({ dealId: id, userId: SELLER });
        return id;
      },
      Completed: async () => {
        const id = await accepted('None');
        const final = await uploaded(id);
        await files.deliverServiceDeal({ dealId: id, userId: SELLER });
        await q(
          `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
          [final]
        );
        await deals.acceptServiceDealDelivery({ dealId: id, userId: BUYER });
        return id;
      },
      Declined: async () => {
        const id = await states.Requested();
        await deals.declineServiceDeal({ dealId: id, userId: SELLER, reason: 'no' });
        return id;
      },
    };
    for (const [status, reach] of Object.entries(states)) {
      await q(
        `TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal" RESTART IDENTITY`
      );
      const dealId = await reach();
      const [row] = await q<{ status: string }>(
        `SELECT status::text FROM "ServiceDeal" WHERE id = $1`,
        [dealId]
      );
      // The setup really reached the state under test (a setup that silently did not would pass).
      expect(row.status).toBe(status);
      await expect(upload(dealId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('refuses a final type we cannot inspect, and archives other than zip', async () => {
    const dealId = await accepted();
    for (const name of [
      'a.rar',
      'a.7z',
      'a.tar.gz',
      'a.exe',
      'a.mp4',
      'a.webm',
      'noextension',
      'a.zip.exe',
    ])
      await expect(upload(dealId, { fileName: name })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toEqual([]);
    for (const name of ['A.ZIP', 'model.safetensors', 'notes.md'])
      await expect(upload(dealId, { fileName: name })).resolves.toBeTruthy();
  });

  it('holds a preview to image types and size, and not to a service that takes none', async () => {
    const none = await accepted('None');
    await expect(
      upload(none, { kind: 'Preview', fileName: 'p.png', mimeType: 'image/png', size: 100 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await q(
      `TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal" RESTART IDENTITY`
    );
    const dealId = await accepted('Image');
    const p = { kind: 'Preview', fileName: 'p.mp4' };
    await expect(upload(dealId, { ...p, mimeType: 'video/mp4', size: 100 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      upload(dealId, {
        kind: 'Preview',
        fileName: 'p.png',
        mimeType: 'image/png',
        size: 11 * 1024 * 1024,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      upload(dealId, {
        kind: 'Preview',
        fileName: 'p.gif',
        mimeType: 'image/gif',
        size: 19 * 1024 * 1024,
      })
    ).resolves.toBeTruthy();
  });

  it('caps previews by the deal kind and finals at the file limit', async () => {
    const dealId = await accepted('Image');
    await upload(dealId, { kind: 'Preview', fileName: 'p.png', mimeType: 'image/png', size: 100 });
    await expect(
      upload(dealId, { kind: 'Preview', fileName: 'q.png', mimeType: 'image/png', size: 100 })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(SERVICE_PREVIEW_MAX_FILES.Image).toBe(1);

    for (let i = 0; i < SERVICE_FINAL_MAX_FILES; i++)
      await upload(dealId, { fileName: `f${i}.zip` });
    await expect(upload(dealId, { fileName: 'extra.zip' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('completing an upload', () => {
  /** The other call finishes while this one is mid-check: Ready, at its own held key. */
  const WINNER_KEY = 'service-deals/files/winner-copy';
  const otherCallFinishes = (fileId: number) =>
    q(`UPDATE "ServiceDealFile" SET status = 'Ready', "s3Key" = $2 WHERE id = $1`, [
      fileId,
      WINNER_KEY,
    ]);

  it('does not fail a file that another call already moved on, nor delete anything', async () => {
    const dealId = await accepted('None');
    const { fileId } = await upload(dealId, { size: 1000 });
    // The first measurement is fine; while this call measures its copy, the other call finishes.
    s3.headObject.mockResolvedValueOnce({ status: 'present', size: 1000 });
    s3.headObject.mockImplementationOnce(async () => {
      await otherCallFinishes(fileId);
      return { status: 'present', size: 999_999 };
    });
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).resolves.toEqual({
      id: fileId,
      status: 'Ready',
    });
    expect(await fileRow(fileId)).toMatchObject({
      status: 'Ready',
      failReason: null,
      s3Key: WINNER_KEY,
    });
    // The delivered file's bytes are not touched, and neither is anything else.
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });

  it('does the same when the losing call is the one that refuses a zip', async () => {
    const dealId = await accepted('None');
    const { fileId } = await upload(dealId, { size: 1000 });
    s3.headObject.mockResolvedValue({ status: 'present', size: 1000 });
    // The held copy's first bytes are not a zip; meanwhile the other call finishes.
    s3.send.mockImplementation(async (command: { input: { Range?: string } }) => {
      if (!command.input.Range) return {};
      await otherCallFinishes(fileId);
      return body(Buffer.from('definitely not a zip file at all'));
    });
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).resolves.toEqual({
      id: fileId,
      status: 'Ready',
    });
    expect(await fileRow(fileId)).toMatchObject({
      status: 'Ready',
      failReason: null,
      s3Key: WINNER_KEY,
    });
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });

  it('measures the object: a size that is not the declared one fails and removes it', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId, { size: 1000 });
    s3.headObject.mockResolvedValue({ status: 'present', size: 999_999 });
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed' });
    expect(s3.deleteObject).toHaveBeenCalledWith(
      'bucket',
      expect.stringContaining('service-deals/')
    );
  });

  it('moves the upload to a key only the server has, and measures THAT copy', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId, { size: 1000 });
    const uploadKey = (await fileRow(fileId)).s3Key;
    s3.send.mockResolvedValue(body(ZIP));
    s3.headObject.mockResolvedValue({ status: 'present', size: 1000 });
    await files.completeServiceDealUpload({ fileId, userId: SELLER });

    const row = await fileRow(fileId);
    expect(row.s3Key).not.toBe(uploadKey);
    expect(row.s3Key).toMatch(new RegExp(`^service-deals/files/${dealId}/0/final/[0-9a-f-]{36}$`));
    const copy = s3.send.mock.calls.map(([command]) => command.input).find((i) => i.CopySource);
    expect(copy).toMatchObject({ Key: row.s3Key, CopySource: `bucket/${uploadKey}` });
    // The seller's key is dead.
    expect(s3.deleteObject).toHaveBeenCalledWith('bucket', uploadKey);
  });

  it('fails a file whose bytes changed after the seller said they were done', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId, { size: 1000 });
    // The seller's key still reads right; the server's copy is what it really is.
    s3.headObject.mockImplementation(async (_bucket: string, key: string) => ({
      status: 'present',
      size: key.includes('/uploads/') ? 1000 : 4_000_000,
    }));
    s3.send.mockResolvedValue(body(ZIP));
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed' });
    expect(s3.deleteObject).toHaveBeenCalledTimes(2);
  });

  it('does not fail a file because the bucket could not be asked', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId);
    s3.headObject.mockResolvedValue({ status: 'unknown' });
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      }
    );
    expect(await fileRow(fileId)).toMatchObject({ status: 'Uploading' });
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });

  it('refuses an object that was never uploaded, and one that is not the seller to complete', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId);
    s3.headObject.mockResolvedValue({ status: 'absent' });
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );
    await expect(files.completeServiceDealUpload({ fileId, userId: BUYER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses a "zip" that is not one, and a password-protected one, and keeps neither', async () => {
    const dealId = await accepted();
    for (const [bytes, why] of [
      [Buffer.from('MZ not a zip at all'), /not a valid/],
      [ENCRYPTED_ZIP, /Password-protected/],
    ] as const) {
      const { fileId } = await upload(dealId, { size: 100 });
      s3.headObject.mockResolvedValue({ status: 'present', size: 100 });
      s3.send.mockResolvedValue(body(bytes as Buffer));
      await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toThrow(
        why
      );
      expect(await fileRow(fileId)).toMatchObject({ status: 'Failed' });
    }
  });

  it('does not delete a zip because the header read failed', async () => {
    const dealId = await accepted();
    const { fileId } = await upload(dealId, { size: 100 });
    s3.headObject.mockResolvedValue({ status: 'present', size: 100 });
    s3.send.mockRejectedValue(new Error('socket hang up'));
    await expect(files.completeServiceDealUpload({ fileId, userId: SELLER })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      }
    );
    expect(await fileRow(fileId)).toMatchObject({ status: 'Uploading' });
    expect(s3.deleteObject).not.toHaveBeenCalled();
  });

  it('sends a preview to processing and leaves a final Ready but unscanned', async () => {
    const dealId = await accepted();
    const finalId = await uploaded(dealId);
    const previewId = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'p.png',
      mimeType: 'image/png',
      size: 500,
    });
    expect(await fileRow(previewId)).toMatchObject({ status: 'Processing', scanStatus: 'Pending' });
    expect(await fileRow(finalId)).toMatchObject({ status: 'Ready', scanStatus: 'Pending' });
  });

  it('is safe to repeat', async () => {
    const dealId = await accepted();
    const fileId = await uploaded(dealId);
    await expect(
      files.completeServiceDealUpload({ fileId, userId: SELLER })
    ).resolves.toMatchObject({
      status: 'Ready',
    });
  });
});

describe('the scanner seam', () => {
  it('outside production with no orchestrator token, submits nothing and never passes a final', async () => {
    setEnv({ ORCHESTRATOR_ACCESS_TOKEN: '' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { submitFinalScan } = await import('~/server/services/creator-service-deal-file-scan');
    const dealId = await accepted();
    const fileId = await uploaded(dealId);
    const target = { id: fileId, dealId, s3Key: 'k', mimeType: 'application/zip', size: 1000 };
    for (let i = 0; i < 3; i++) expect(await submitFinalScan(target)).toBe('Pending');
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Pending',
      malwareScanStatus: 'Pending',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('deleting', () => {
  it('cannot drop a file once the round is delivered', async () => {
    const dealId = await accepted('None');
    const fileId = await uploaded(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await expect(files.deleteServiceDealFile({ fileId, userId: SELLER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toHaveLength(1);
  });

  it('takes the hidden scan copy of a preview deleted mid-scan with it', async () => {
    const dealId = await accepted();
    const fileId = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'p.png',
      mimeType: 'image/png',
      size: 500,
    });
    s3.send.mockResolvedValue(body(Buffer.from('original bytes')));
    preview.scanCopy.mockResolvedValue({
      data: Buffer.from('c'),
      mimeType: 'image/webp',
      width: 10,
      height: 10,
      frames: 1,
    });
    s3.uploadImageBufferToStore.mockResolvedValue({ key: 'scan-copy-key' });
    images.createImage.mockResolvedValue({ id: 321 });
    images.deleteImageById.mockResolvedValue(undefined);
    await files.startPreviewScans();
    expect((await fileRow(fileId)).imageId).toBe(321);

    await files.deleteServiceDealFile({ fileId, userId: SELLER });
    expect(images.deleteImageById).toHaveBeenCalledWith({ id: 321, updatePost: false });
  });

  it('leaves a delivered round alone: after a revision its files can be neither completed nor removed', async () => {
    const dealId = await accepted('None');
    const old = await uploaded(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await deals.requestServiceDealRevision({ dealId, userId: BUYER, comment: 'again' });
    await expect(
      files.deleteServiceDealFile({ fileId: old, userId: SELLER })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      files.completeServiceDealUpload({ fileId: old, userId: SELLER })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await fileRow(old)).toMatchObject({ round: 0 });
  });

  it('lets the seller drop a file from the round being worked, and nobody else', async () => {
    const dealId = await accepted();
    const fileId = await uploaded(dealId);
    await expect(files.deleteServiceDealFile({ fileId, userId: BUYER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await files.deleteServiceDealFile({ fileId, userId: SELLER });
    expect(await q(`SELECT 1 FROM "ServiceDealFile"`)).toEqual([]);
  });
});

describe('delivering', () => {
  it('needs a Ready preview and a Ready final, and moves the deal to Delivered once it has both', async () => {
    const dealId = await accepted();
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await uploaded(dealId);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await readyPreview(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    const [row] = await q<{ status: string }>(
      `SELECT status::text FROM "ServiceDeal" WHERE id = $1`,
      [dealId]
    );
    expect(row.status).toBe('Delivered');
  });

  it('is held back by a preview still processing or failed, and by a final still uploading', async () => {
    const dealId = await accepted();
    await uploaded(dealId);
    const previewId = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'p.png',
      mimeType: 'image/png',
      size: 500,
    });
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await q(`UPDATE "ServiceDealFile" SET status = 'Failed' WHERE id = $1`, [previewId]);
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Ready', "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [previewId]
    );
    await upload(dealId, { fileName: 'still-uploading.zip' });
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('waits for EVERY sample preview, not just one', async () => {
    const dealId = await accepted('SampleOutputs');
    await uploaded(dealId);
    await readyPreview(dealId);
    const second = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'q.png',
      mimeType: 'image/png',
      size: 500,
    });
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Ready', "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [second]
    );
    await files.deliverServiceDeal({ dealId, userId: SELLER });
  });

  it('needs no preview when the service takes none', async () => {
    const dealId = await accepted('None');
    await uploaded(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
  });

  it('answers anyone but the seller with not-found', async () => {
    const dealId = await accepted('None');
    await uploaded(dealId);
    await expect(files.deliverServiceDeal({ dealId, userId: BUYER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it("judges the CURRENT round: last round's files do not satisfy a revision", async () => {
    const dealId = await accepted('None');
    await uploaded(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await deals.requestServiceDealRevision({ dealId, userId: BUYER, comment: 'more cat' });
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const second = await uploaded(dealId);
    expect(await fileRow(second)).toMatchObject({ round: 1 });
    await files.deliverServiceDeal({ dealId, userId: SELLER });
  });
});

describe('who can download what', () => {
  /** A delivered deal with one clean-or-not final and a ready preview. */
  async function delivered(scan: 'Passed' | 'Pending' | 'Failed' = 'Passed') {
    const dealId = await accepted();
    const finalId = await uploaded(dealId);
    const previewId = await readyPreview(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = $1::"ServiceDealFileScanStatus",
        "malwareScanStatus" = $1::"ServiceDealFileScanStatus", "deliveryKey" = $3, "deliverySize" = 777, "repackedAt" = now() WHERE id = $2`,
      [scan, finalId, DELIVERY_KEY]
    );
    return { dealId, finalId, previewId };
  }
  const complete = (dealId: number) => deals.acceptServiceDealDelivery({ dealId, userId: BUYER });

  it('gives the buyer nothing before the deal is completed, even for a clean final', async () => {
    const { finalId } = await delivered('Passed');
    expect(await download(finalId, BUYER)).toBeNull();
  });

  const DELIVERY_KEY = 'service-deals/delivered/built-by-the-server';

  it('gives the buyer the server-built archive', async () => {
    const { dealId, finalId } = await delivered('Passed');
    await complete(dealId);
    const [row] = await q<{ s3Key: string }>(
      `SELECT "s3Key" FROM "ServiceDealFile" WHERE id = $1`,
      [finalId]
    );
    expect(await download(finalId, BUYER)).toMatchObject({ key: DELIVERY_KEY });
    expect(row.s3Key).not.toBe(DELIVERY_KEY);
    expect(await download(finalId, SELLER)).toMatchObject({ key: row.s3Key });
    expect(await download(finalId, MOD, true)).toMatchObject({ key: row.s3Key });
    expect(
      await files.resolveServiceDealFileDownload({
        fileId: finalId,
        userId: MOD,
        isModerator: true,
        delivered: true,
      })
    ).toMatchObject({ key: DELIVERY_KEY });
  });

  it('never gives the buyer a zip that has no built archive, even a Passed one', async () => {
    const { dealId, finalId } = await delivered('Passed');
    await complete(dealId);
    await q(`UPDATE "ServiceDealFile" SET "deliveryKey" = NULL WHERE id = $1`, [finalId]);
    expect(await download(finalId, BUYER)).toBeNull();
    expect(
      await files.resolveServiceDealFileDownload({
        fileId: finalId,
        userId: MOD,
        isModerator: true,
        delivered: true,
      })
    ).toBeNull();
    expect(await download(finalId, MOD, true)).not.toBeNull();
  });

  it('serves a file that is not an archive as it was uploaded', async () => {
    const dealId = await accepted();
    const finalId = await uploaded(dealId, { fileName: 'notes.txt', mimeType: 'text/plain' });
    await files.deliverServiceDeal({ dealId, userId: SELLER }).catch(() => null);
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed', "repackedAt" = now() WHERE id = $1`,
      [finalId]
    );
    await q(
      `UPDATE "ServiceDeal" SET status = 'Completed', "completedAt" = now(), "releaseAt" = now() + interval '2 days' WHERE id = $1`,
      [dealId]
    );
    const [row] = await q<{ s3Key: string }>(
      `SELECT "s3Key" FROM "ServiceDealFile" WHERE id = $1`,
      [finalId]
    );
    expect(await download(finalId, BUYER)).toMatchObject({ key: row.s3Key });
  });

  it('tells the buyer the size of what they will download', async () => {
    const { dealId, finalId } = await delivered('Passed');
    await complete(dealId);
    const seen = (await list(dealId, BUYER)).find((f) => f.id === finalId);
    expect(seen?.size).toBe(777);
    expect((await list(dealId, SELLER)).find((f) => f.id === finalId)?.size).toBe(1000);
  });

  it('gives the buyer a Passed final after completion, and a signed URL for it', async () => {
    const { dealId, finalId } = await delivered('Passed');
    await complete(dealId);
    const target = await download(finalId, BUYER);
    expect(target).toMatchObject({ bucket: 'bucket', fileName: 'result.zip' });
    expect(await files.getServiceDealFileDownloadUrl(target!)).toMatch(
      /^https:\/\/get\/service-deals\//
    );
    expect(s3.getGetUrlByKey).toHaveBeenCalledWith(
      target!.key,
      expect.objectContaining({ expiresIn: 300, fileName: 'result.zip' })
    );
  });

  it.each(['Pending', 'Failed'] as const)(
    'never gives the buyer a final whose scan is %s',
    async (scan) => {
      const { dealId, finalId } = await delivered(scan);
      await q(
        `UPDATE "ServiceDeal" SET status = 'Completed', "completedAt" = now(), "releaseAt" = now() + interval '2 days' WHERE id = $1`,
        [dealId]
      );
      expect(await download(finalId, BUYER)).toBeNull();
    }
  );

  it("keeps the buyer out of earlier rounds, previews' originals and other deals", async () => {
    const { dealId, finalId, previewId } = await delivered('Passed');
    await complete(dealId);
    expect(await download(previewId, BUYER)).toBeNull();
    expect(await download(finalId, STRANGER)).toBeNull();
    await q(`UPDATE "ServiceDealFile" SET round = 5 WHERE id = $1`, [finalId]);
    expect(await download(finalId, BUYER)).toBeNull();
  });

  it('keeps a buyer whose paid deal went to dispute, and drops one whose deal was refunded', async () => {
    const { dealId, finalId } = await delivered('Passed');
    await complete(dealId);
    await q(
      `UPDATE "ServiceDeal" SET status = 'Disputed', "disputeOpenedAt" = now(), "disputeReason" = 'x' WHERE id = $1`,
      [dealId]
    );
    expect(await download(finalId, BUYER)).not.toBeNull();
    await q(
      `UPDATE "ServiceDeal" SET status = 'Cancelled', "closedAt" = now(), "closeReason" = 'x', "settledAt" = now() WHERE id = $1`,
      [dealId]
    );
    expect(await download(finalId, BUYER)).toBeNull();
  });

  it('gives the seller their own files always, and a moderator any file', async () => {
    const { finalId, previewId } = await delivered('Pending');
    expect(await download(finalId, SELLER)).not.toBeNull();
    expect(await download(previewId, SELLER)).not.toBeNull();
    expect(await download(finalId, MOD, true)).not.toBeNull();
    expect(await download(finalId, MOD, false)).toBeNull();
    expect(await download(999, SELLER)).toBeNull();
  });
});

describe('what the listing shows', () => {
  async function delivered() {
    const dealId = await accepted();
    const finalId = await uploaded(dealId, { fileName: 'secret-name.zip' });
    const previewId = await readyPreview(dealId);
    await q(`UPDATE "ServiceDealFile" SET "watermarkedKey" = 'abc-uuid' WHERE id = $1`, [
      previewId,
    ]);
    return { dealId, finalId, previewId };
  }

  it('shows the buyer nothing while the seller is still working the round', async () => {
    const { dealId } = await delivered();
    expect(await list(dealId, BUYER)).toEqual([]);
    expect((await list(dealId, SELLER)).map((f) => f.kind).sort()).toEqual(['Final', 'Preview']);
  });

  it('keeps an undelivered round hidden when the deal is cancelled, not only while it is being worked', async () => {
    const { dealId } = await delivered();
    await deals.requestServiceDealCancellation({
      dealId,
      userId: BUYER,
      reason: 'changed my mind',
    });
    const [row] = await q<{ status: string }>(
      `SELECT status::text FROM "ServiceDeal" WHERE id = $1`,
      [dealId]
    );
    expect(row.status).toBe('CancellationRequested');
    expect(await list(dealId, BUYER)).toEqual([]);
    expect(await list(dealId, SELLER)).toHaveLength(2);
  });

  it('shows the buyer a delivered round but not the revision being worked', async () => {
    const { dealId, finalId } = await delivered();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await deals.requestServiceDealRevision({ dealId, userId: BUYER, comment: 'again' });
    const second = await uploaded(dealId, { fileName: 'second.zip' });
    expect((await fileRow(second)).round).toBe(1);
    const seen = (await list(dealId, BUYER)).map((f) => f.id);
    expect(seen).toContain(finalId);
    expect(seen).not.toContain(second);
  });

  it('shows the buyer the cleared preview and a locked final with no name', async () => {
    const { dealId, finalId, previewId } = await delivered();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    const seen = await list(dealId, BUYER);
    expect(seen.find((f) => f.id === previewId)).toMatchObject({
      status: 'Ready',
      previewUrl: expect.stringContaining('abc-uuid'),
      canDownload: false,
    });
    expect(seen.find((f) => f.id === finalId)).toMatchObject({
      fileName: null,
      mimeType: null,
      canDownload: false,
    });
    expect(JSON.stringify(seen)).not.toContain('secret-name');
    expect(JSON.stringify(seen)).not.toContain('service-deals/');
  });

  it('never shows the buyer a preview that is not Ready', async () => {
    const { dealId, previewId } = await delivered();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    for (const status of ['Processing', 'Failed']) {
      await q(`UPDATE "ServiceDealFile" SET status = $1::"ServiceDealFileStatus" WHERE id = $2`, [
        status,
        previewId,
      ]);
      expect((await list(dealId, BUYER)).find((f) => f.id === previewId)).toBeUndefined();
    }
  });

  it('flags canDownload for the buyer only once the deal is completed and the file Passed', async () => {
    const { dealId, finalId } = await delivered();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [finalId]
    );
    expect((await list(dealId, BUYER)).find((f) => f.id === finalId)!.canDownload).toBe(false);
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    const unlocked = (await list(dealId, BUYER)).find((f) => f.id === finalId)!;
    expect(unlocked).toMatchObject({ canDownload: true, fileName: 'secret-name.zip' });
  });

  it('keeps canDownload false for a completed deal whose final has not passed its scan', async () => {
    const { dealId, finalId } = await delivered();
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    // The completion gate keeps this from happening; it is reached by clearing the scan afterwards.
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [finalId]
    );
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    await q(`UPDATE "ServiceDealFile" SET "scanStatus" = 'Pending' WHERE id = $1`, [finalId]);
    const locked = (await list(dealId, BUYER)).find((f) => f.id === finalId)!;
    expect(locked).toMatchObject({ canDownload: false, scanStatus: 'Pending', fileName: null });
  });

  it('answers a stranger with not-found and lets a moderator see everything', async () => {
    const { dealId } = await delivered();
    await expect(list(dealId, STRANGER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await list(dealId, MOD, true)).toHaveLength(2);
  });
});

describe('preview pipeline', () => {
  const waiting = async () => {
    const dealId = await accepted();
    const fileId = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'p.png',
      mimeType: 'image/png',
      size: 500,
    });
    // `uploaded` leaves the bucket answering with a zip header; the pipeline reads the original.
    s3.send.mockResolvedValue(body(Buffer.from('original bytes')));
    return { dealId, fileId };
  };

  const SCAN_COPY = Buffer.from('unmarked scan copy');
  const DERIVATIVE = Buffer.from('marked derivative');

  beforeEach(() => {
    images.createImage.mockReset();
    images.deleteImageById.mockReset();
    preview.scanCopy.mockReset();
    s3.send.mockResolvedValue(body(Buffer.from('original bytes')));
    preview.scanCopy.mockResolvedValue({
      data: SCAN_COPY,
      mimeType: 'image/webp',
      width: 1024,
      height: 600,
      frames: 1,
    });
    preview.build.mockResolvedValue({
      data: DERIVATIVE,
      mimeType: 'image/webp',
      width: 512,
      height: 300,
      frames: 1,
    });
    s3.uploadImageBufferToStore.mockImplementation(async (data: Buffer) => ({
      key: data.equals(SCAN_COPY) ? 'scan-copy-key' : 'derivative-key',
    }));
    images.createImage.mockImplementation(async ({ url }: { url: string }) => {
      const [row] = await q<{ id: number }>(`INSERT INTO "Image" (url) VALUES ($1) RETURNING id`, [
        url,
      ]);
      return { id: row.id };
    });
    images.deleteImageById.mockImplementation(async ({ id }: { id: number }) => {
      await q(`DELETE FROM "Image" WHERE id = $1`, [id]);
    });
  });

  const verdict = (ingestion: string, flags = '') =>
    q(`UPDATE "Image" SET ingestion = $1::"ImageIngestionStatus"${flags}`, [ingestion]);

  it('scans a hidden, downscaled, UNMARKED copy first, owned by the seller, and marks nothing yet', async () => {
    const { fileId } = await waiting();
    expect(await files.startPreviewScans()).toBe(1);

    const row = await fileRow(fileId);
    expect(row).toMatchObject({
      scanKey: 'scan-copy-key',
      status: 'Processing',
      scanStatus: 'Pending',
    });
    expect(row.imageId).not.toBeNull();
    expect(row.watermarkedKey).toBeNull();
    expect(s3.uploadImageBufferToStore).toHaveBeenCalledTimes(1);
    expect(s3.uploadImageBufferToStore).toHaveBeenCalledWith(SCAN_COPY, expect.anything());
    // Ingestion is NOT skipped: this is a real scan.
    const created = images.createImage.mock.calls[0][0];
    expect(created).toMatchObject({ url: 'scan-copy-key', userId: SELLER });
    expect(created).not.toHaveProperty('skipIngestion');
    // The mark does not exist yet, so the scanner cannot have seen it.
    expect(preview.build).not.toHaveBeenCalled();
  });

  it('does not scan twice, and a crash after the object was stored reuses it', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    expect(await files.startPreviewScans()).toBe(0);
    expect(images.createImage).toHaveBeenCalledTimes(1);

    // A pod died between recording the key and recording the Image: the row exists, the link does not.
    await q(
      `UPDATE "ServiceDealFile" SET "imageId" = NULL, "processingAt" = now() - interval '1 hour' WHERE id = $1`,
      [fileId]
    );
    s3.uploadImageBufferToStore.mockClear();
    expect(await files.startPreviewScans()).toBe(1);
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
    expect(images.createImage).toHaveBeenCalledTimes(1);
    expect((await fileRow(fileId)).imageId).not.toBeNull();
  });

  it('marks nothing while the scan is pending, and passes a clean verdict without publishing', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();

    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Pending', status: 'Processing' });
    expect(await files.publishPreviews()).toBe(0);
    expect(preview.build).not.toHaveBeenCalled();

    await verdict('Scanned');
    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({
      scanStatus: 'Passed',
      status: 'Processing',
      watermarkedKey: null,
    });
  });

  it('burns the mark from the ORIGINAL only after the pass, then publishes and is Ready', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await verdict('Scanned');
    await files.settlePreviewScans();

    expect(await files.publishPreviews()).toBe(1);
    expect(await fileRow(fileId)).toMatchObject({
      status: 'Ready',
      scanStatus: 'Passed',
      watermarkedKey: 'derivative-key',
    });
    expect(preview.build).toHaveBeenCalledWith(Buffer.from('original bytes'));
    // Scanned first, marked second: the order is the point.
    expect(preview.scanCopy.mock.invocationCallOrder[0]).toBeLessThan(
      preview.build.mock.invocationCallOrder[0]
    );
    // The published object is the marked derivative, never the scan copy.
    expect(s3.uploadImageBufferToStore).toHaveBeenLastCalledWith(DERIVATIVE, expect.anything());
  });

  it.each([
    ['blocked', `'Blocked'`, ''],
    ['flagged for review', `'Scanned'`, `, "needsReview" = 'poi'`],
    ['a person of interest', `'Scanned'`, `, poi = true`],
    ['a minor', `'Scanned'`, `, minor = true`],
  ])(
    'stops a preview that came back %s: no mark, no publish, failed for good',
    async (_n, ingestion, flags) => {
      const { fileId } = await waiting();
      await files.startPreviewScans();
      await q(`UPDATE "Image" SET ingestion = ${ingestion}::"ImageIngestionStatus"${flags}`);
      await files.settlePreviewScans();

      expect(await fileRow(fileId)).toMatchObject({ status: 'Failed', scanStatus: 'Failed' });
      expect(await files.publishPreviews()).toBe(0);
      expect(preview.build).not.toHaveBeenCalled();
      expect((await list(1, BUYER)).filter((f) => f.kind === 'Preview')).toEqual([]);
    }
  );

  it('passes a PG or PG-13 preview and records the rating the scan gave it', async () => {
    for (const level of [1, 2]) {
      await q(
        `TRUNCATE "ServiceDealTransaction", "ServiceDealEvent", "ServiceDealFileEntry", "ServiceDealFile", "ServiceDeal", "Image" RESTART IDENTITY`
      );
      const { fileId } = await waiting();
      await files.startPreviewScans();
      await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = $1`, [level]);
      await files.settlePreviewScans();
      expect(await fileRow(fileId)).toMatchObject({ scanStatus: 'Passed', nsfwLevel: level });
    }
  });

  it.each([4, 8, 16, 32])('rejects a preview the scan rated %i: SFW only in v1', async (level) => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = $1`, [level]);
    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed', scanStatus: 'Failed' });
    expect(await files.publishPreviews()).toBe(0);
    expect(preview.build).not.toHaveBeenCalled();
  });

  it('does not pass a scanned preview the scan left unrated', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await q(`UPDATE "Image" SET ingestion = 'Scanned', "nsfwLevel" = 0`);
    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({ status: 'Processing', scanStatus: 'Pending' });
  });

  it('fails, without calling the content bad, a scan that could not run', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await verdict('NotFound');
    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed', scanStatus: 'Pending' });
  });

  it('deletes the hidden copy once a verdict exists, and not before', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    const { imageId } = await fileRow(fileId);

    expect(await files.deleteScanCopies()).toBe(0);
    expect(images.deleteImageById).not.toHaveBeenCalled();

    await verdict('Scanned');
    await files.settlePreviewScans();
    expect(await files.deleteScanCopies()).toBe(1);
    expect(images.deleteImageById).toHaveBeenCalledWith({ id: imageId, updatePost: false });
    expect(await fileRow(fileId)).toMatchObject({ imageId: null, scanKey: null });
    expect(await q(`SELECT 1 FROM "Image"`)).toEqual([]);
  });

  it('keeps the copy of a REJECTED preview for moderation, and deletes a passed one', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await verdict('Blocked');
    await files.settlePreviewScans();
    expect(await files.deleteScanCopies()).toBe(0);
    expect(images.deleteImageById).not.toHaveBeenCalled();
    expect((await fileRow(fileId)).imageId).not.toBeNull();
    expect(await q(`SELECT 1 FROM "Image"`)).toHaveLength(1);
  });

  it('keeps the pointer when a delete fails, so the copy is retried', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await verdict('Scanned');
    await files.settlePreviewScans();

    images.deleteImageById.mockRejectedValueOnce(new Error('s3 down'));
    expect(await files.deleteScanCopies()).toBe(0);
    expect((await fileRow(fileId)).imageId).not.toBeNull();
    expect(await files.deleteScanCopies()).toBe(1);
    expect((await fileRow(fileId)).imageId).toBeNull();
  });

  it('re-creates the Image row when a crash left the stored object but no row', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await q(`DELETE FROM "Image"`);
    await q(
      `UPDATE "ServiceDealFile" SET "imageId" = NULL, "processingAt" = now() - interval '1 hour' WHERE id = $1`,
      [fileId]
    );
    s3.uploadImageBufferToStore.mockClear();
    expect(await files.startPreviewScans()).toBe(1);
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
    expect(images.createImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: 'scan-copy-key' })
    );
    expect((await fileRow(fileId)).imageId).not.toBeNull();
  });

  it('only publishes a file that is still Processing and Passed, even if it changed after the claim', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await verdict('Scanned');
    await files.settlePreviewScans();
    // Failed by something else after it passed: the claim must not pick it up...
    await q(`UPDATE "ServiceDealFile" SET status = 'Failed' WHERE id = $1`, [fileId]);
    expect(await files.publishPreviews()).toBe(0);
    expect(preview.build).not.toHaveBeenCalled();
    // ...and a file that fails WHILE it is being built is not made Ready by the write.
    await q(
      `UPDATE "ServiceDealFile" SET status = 'Processing', "processingAt" = NULL WHERE id = $1`,
      [fileId]
    );
    preview.build.mockImplementationOnce(async () => {
      await q(`UPDATE "ServiceDealFile" SET status = 'Failed' WHERE id = $1`, [fileId]);
      return { data: DERIVATIVE, mimeType: 'image/webp', width: 512, height: 300, frames: 1 };
    });
    await files.publishPreviews();
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed' });
  });

  it('fails a preview the seller can fix, with the reason, before anything is stored', async () => {
    const { fileId } = await waiting();
    preview.scanCopy.mockRejectedValueOnce(new PreviewRejectedError('at most 60 frames'));
    await files.startPreviewScans();
    expect(await fileRow(fileId)).toMatchObject({
      status: 'Failed',
      failReason: 'at most 60 frames',
    });
    expect(s3.uploadImageBufferToStore).not.toHaveBeenCalled();
    expect(images.createImage).not.toHaveBeenCalled();
  });

  it('leaves a preview alone on a transient failure and retries it once the claim is stale', async () => {
    const { fileId } = await waiting();
    preview.scanCopy.mockRejectedValueOnce(new Error('transient'));
    expect(await files.startPreviewScans()).toBe(0);
    expect(await files.startPreviewScans()).toBe(0);
    expect(preview.scanCopy).toHaveBeenCalledTimes(1);
    await q(
      `UPDATE "ServiceDealFile" SET "processingAt" = now() - interval '1 hour' WHERE id = $1`,
      [fileId]
    );
    expect(await files.startPreviewScans()).toBe(1);
  });

  it('gives up on a preview that never settles', async () => {
    const { fileId } = await waiting();
    await files.startPreviewScans();
    await q(
      `UPDATE "ServiceDealFile" SET "uploadedAt" = now() - interval '7 hours' WHERE id = $1`,
      [fileId]
    );
    await files.settlePreviewScans();
    expect(await fileRow(fileId)).toMatchObject({ status: 'Failed' });
    expect(await files.deleteScanCopies()).toBe(1);
  });
});

describe('a scanner verdict on a final', () => {
  const dealStatus = async (id: number) =>
    (
      await q<{ status: string; disputeReason: string | null }>(
        `SELECT status::text, "disputeReason" FROM "ServiceDeal" WHERE id = $1`,
        [id]
      )
    )[0];

  /** What a passing Final has: unpacked, and its malware scan passed (the stub never does this). */
  const clearForPass = (fileId: number) =>
    q(
      `UPDATE "ServiceDealFile" SET "unpackedAt" = now(), "repackedAt" = now(), "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [fileId]
    );

  async function deliveredWithFinal() {
    const dealId = await accepted('None');
    const finalId = await uploaded(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    return { dealId, finalId };
  }

  it('records a pass, and nothing else changes', async () => {
    const { dealId, finalId } = await deliveredWithFinal();
    await clearForPass(finalId);
    expect(await files.recordFinalScanResult({ fileId: finalId, verdict: 'Passed' })).toEqual({
      recorded: true,
      held: false,
    });
    expect(await fileRow(finalId)).toMatchObject({ scanStatus: 'Passed' });
    expect((await dealStatus(dealId)).status).toBe('Delivered');
  });

  it('sends a delivered deal to the moderators when a final fails', async () => {
    const { dealId, finalId } = await deliveredWithFinal();
    expect(await files.recordFinalScanResult({ fileId: finalId, verdict: 'Failed' })).toEqual({
      recorded: true,
      held: true,
    });
    expect(await fileRow(finalId)).toMatchObject({ scanStatus: 'Failed' });
    expect(await dealStatus(dealId)).toEqual({
      status: 'Disputed',
      disputeReason: 'final_scan_failed',
    });
  });

  it('also holds a completed deal whose payout has not been claimed', async () => {
    const { dealId, finalId } = await deliveredWithFinal();
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed' WHERE id = $1`,
      [finalId]
    );
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    await q(`UPDATE "ServiceDealFile" SET "scanStatus" = 'Pending' WHERE id = $1`, [finalId]);
    await files.recordFinalScanResult({ fileId: finalId, verdict: 'Failed' });
    expect((await dealStatus(dealId)).status).toBe('Disputed');
  });

  it('takes only the first verdict: a late or repeated one cannot overturn it', async () => {
    const { dealId, finalId } = await deliveredWithFinal();
    await files.recordFinalScanResult({ fileId: finalId, verdict: 'Failed' });
    expect(await files.recordFinalScanResult({ fileId: finalId, verdict: 'Passed' })).toEqual({
      recorded: false,
      held: false,
    });
    expect(await fileRow(finalId)).toMatchObject({ scanStatus: 'Failed' });
    expect((await dealStatus(dealId)).status).toBe('Disputed');
  });

  it('ignores a preview and an unknown file', async () => {
    const dealId = await accepted();
    const previewId = await uploaded(dealId, {
      kind: 'Preview',
      fileName: 'p.png',
      mimeType: 'image/png',
      size: 500,
    });
    expect(
      await files.recordFinalScanResult({ fileId: previewId, verdict: 'Passed' })
    ).toMatchObject({ recorded: false });
    expect(await files.recordFinalScanResult({ fileId: 99999, verdict: 'Failed' })).toMatchObject({
      recorded: false,
    });
    expect(await fileRow(previewId)).toMatchObject({ scanStatus: 'Pending' });
  });

  it('does not hold a deal that is not delivered yet, but stops it being delivered', async () => {
    const dealId = await accepted('None');
    const finalId = await uploaded(dealId);
    expect(await files.recordFinalScanResult({ fileId: finalId, verdict: 'Failed' })).toEqual({
      recorded: true,
      held: false,
    });
    expect((await dealStatus(dealId)).status).toBe('Accepted');
    await expect(files.deliverServiceDeal({ dealId, userId: SELLER })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Replacing the failed file clears the way.
    await files.deleteServiceDealFile({ fileId: finalId, userId: SELLER });
    await uploaded(dealId, { fileName: 'fixed.zip' });
    await files.deliverServiceDeal({ dealId, userId: SELLER });
  });
});

describe('recording who took a file', () => {
  async function completedDeal() {
    const dealId = await accepted();
    const finalId = await uploaded(dealId);
    await readyPreview(dealId);
    await files.deliverServiceDeal({ dealId, userId: SELLER });
    await q(
      `UPDATE "ServiceDealFile" SET "scanStatus" = 'Passed', "malwareScanStatus" = 'Passed',
        "deliveryKey" = 'service-deals/delivered/k', "repackedAt" = now() WHERE id = $1`,
      [finalId]
    );
    await deals.acceptServiceDealDelivery({ dealId, userId: BUYER });
    return { dealId, finalId };
  }
  const take = async (target: Awaited<ReturnType<typeof download>>) =>
    files.getServiceDealFileDownloadUrl(target!);
  const accesses = () =>
    q<{ dealId: number; fileId: number; userId: number; role: string; kind: string }>(
      `SELECT "dealId", "fileId", "userId", role::text, kind::text FROM "ServiceDealFileAccess" ORDER BY id`
    );

  it("records the buyer's download of a final", async () => {
    const { dealId, finalId } = await completedDeal();
    await take(await download(finalId, BUYER));
    await vi.waitFor(async () =>
      expect(await accesses()).toEqual([
        { dealId, fileId: finalId, userId: BUYER, role: 'Buyer', kind: 'Download' },
      ])
    );
  });

  it('records the seller and a moderator apart from the buyer, and summarises per file', async () => {
    const { dealId, finalId } = await completedDeal();
    await take(await download(finalId, BUYER));
    await take(await download(finalId, BUYER));
    await take(await download(finalId, SELLER));
    await take(
      await files.resolveServiceDealFileDownload({
        fileId: finalId,
        userId: MOD,
        isModerator: true,
        moderatorFetch: true,
      })
    );
    await vi.waitFor(async () => expect(await accesses()).toHaveLength(4));
    expect((await accesses()).map((a) => [a.role, a.kind])).toEqual([
      ['Buyer', 'Download'],
      ['Buyer', 'Download'],
      ['Seller', 'Download'],
      ['Moderator', 'ModeratorFetch'],
    ]);

    const summary = await files.listServiceDealFileAccess([dealId]);
    expect(summary.map(({ fileId, role, kind, count }) => ({ fileId, role, kind, count }))).toEqual(
      [
        { fileId: finalId, role: 'Buyer', kind: 'Download', count: 2 },
        { fileId: finalId, role: 'Seller', kind: 'Download', count: 1 },
        { fileId: finalId, role: 'Moderator', kind: 'ModeratorFetch', count: 1 },
      ]
    );
    expect(summary[0].firstAt <= summary[0].lastAt).toBe(true);
  });

  it('still hands out the link when the record cannot be written, and logs it', async () => {
    const { finalId } = await completedDeal();
    const target = await download(finalId, BUYER);
    await q(`ALTER TABLE "ServiceDealFileAccess" RENAME TO "ServiceDealFileAccessGone"`);
    try {
      expect(await take(target)).toBe('https://get/service-deals/delivered/k');
      await vi.waitFor(() =>
        expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'creator-service-file-access' })
        )
      );
    } finally {
      await q(`ALTER TABLE "ServiceDealFileAccessGone" RENAME TO "ServiceDealFileAccess"`);
    }
  });
});
