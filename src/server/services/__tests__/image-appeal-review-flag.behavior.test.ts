import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * An image appeal must never overwrite the moderator-only review flag: once overwritten, a rejected
 * appeal clears it and the blocked-image purge is free to delete the image. The handler refuses such
 * an image off a replica read, so these pin the two writers that act under the row lock.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const { mockCreateMultiAccountBuzzTransaction, mockRefundMultiAccountTransaction } = vi.hoisted(
  () => ({
    mockCreateMultiAccountBuzzTransaction: vi.fn(),
    mockRefundMultiAccountTransaction: vi.fn(),
  })
);

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCreateMultiAccountBuzzTransaction,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));

import { createEntityAppeal } from '~/server/services/report.service';
import {
  keepPendingAppealFlags,
  releaseSettledAppealFlags,
} from '~/server/services/image-appeal-flag';
import { EntityType } from '~/shared/utils/prisma/enums';
import { IMAGE_NOT_APPEALABLE } from '~/shared/utils/appeal';

const FLAGGED = 1;
const PLAIN = 2;
const OTHER_FLAG = 3;
const CSAM_BLOCKED = 4;
const MODERATED_BLOCKED = 5;

const runOnStandIn = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return (await holder.db.query(flat.text, flat.values as unknown[])).affectedRows ?? 0;
};
const tx = { $executeRaw: vi.fn(runOnStandIn), appeal: { create: vi.fn(async () => ({ id: 1 })) } };

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, "needsReview" text, "blockedFor" text, "updatedAt" timestamp(3));
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation(((cb: (t: typeof tx) => unknown) =>
    cb(tx)) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(runOnStandIn as never);
  dbMock.dbRead.appeal.count.mockResolvedValue(5);
  mockCreateMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 1 });
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal";
    INSERT INTO "Image" (id, "needsReview") VALUES
      (${FLAGGED}, 'csam'), (${PLAIN}, NULL), (${OTHER_FLAG}, 'minor');
    INSERT INTO "Image" (id, "needsReview", "blockedFor") VALUES
      (${CSAM_BLOCKED}, 'minor', 'CSAM'), (${MODERATED_BLOCKED}, NULL, 'moderated');
    INSERT INTO "Appeal" ("entityType", "entityId", status) VALUES
      ('Image', ${FLAGGED}, 'Pending'), ('Image', ${PLAIN}, 'Pending'), ('Image', ${OTHER_FLAG}, 'Pending'),
      ('Image', ${CSAM_BLOCKED}, 'Pending'), ('Image', ${MODERATED_BLOCKED}, 'Pending');
  `);
});

const flagOf = async (id: number) =>
  (
    await holder.db.query<{ needsReview: string | null }>(
      `SELECT "needsReview" FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0].needsReview;

const appeal = (entityId: number) =>
  createEntityAppeal({
    entityId,
    entityType: EntityType.Image,
    message: 'Please review again.',
    userId: 990100013,
    buzzType: 'user',
  });

describe('creating an image appeal', () => {
  it('refuses an image carrying the moderator-only flag, refunds the fee and keeps the flag', async () => {
    await expect(appeal(FLAGGED)).rejects.toThrow(IMAGE_NOT_APPEALABLE);

    expect(await flagOf(FLAGGED)).toBe('csam');
    expect(tx.appeal.create).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses an image holding a CSAM block, with the same answer, and keeps its review', async () => {
    await expect(appeal(CSAM_BLOCKED)).rejects.toThrow(IMAGE_NOT_APPEALABLE);

    expect(await flagOf(CSAM_BLOCKED)).toBe('minor');
    expect(tx.appeal.create).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no flag', PLAIN],
    ['another review flag', OTHER_FLAG],
    ['a moderator block', MODERATED_BLOCKED],
  ])('flags an image with %s for the appeals queue', async (_, id) => {
    await appeal(id);

    expect(await flagOf(id)).toBe('appeal');
    expect(tx.appeal.create).toHaveBeenCalledTimes(1);
  });
});

describe('keepPendingAppealFlags', () => {
  it('restores the appeal flag but never over the moderator-only flag', async () => {
    await keepPendingAppealFlags([FLAGGED, PLAIN, OTHER_FLAG]);

    expect(await flagOf(FLAGGED)).toBe('csam');
    expect(await flagOf(PLAIN)).toBe('appeal');
    expect(await flagOf(OTHER_FLAG)).toBe('appeal');
  });

  it('never restores the appeal flag on an image holding a CSAM block', async () => {
    await keepPendingAppealFlags([CSAM_BLOCKED, PLAIN, MODERATED_BLOCKED]);

    expect(await flagOf(CSAM_BLOCKED)).toBe('minor');
    // Controls: the same call restores it on an image with no block, and with another block.
    expect(await flagOf(PLAIN)).toBe('appeal');
    expect(await flagOf(MODERATED_BLOCKED)).toBe('appeal');
  });
});

describe('releaseSettledAppealFlags', () => {
  it('takes the appeal flag off an image whose appeal is no longer pending', async () => {
    await holder.db.exec(`
      UPDATE "Image" SET "needsReview" = 'appeal' WHERE id IN (${PLAIN}, ${OTHER_FLAG});
      UPDATE "Appeal" SET status = 'Rejected' WHERE "entityId" = ${PLAIN};
    `);

    await releaseSettledAppealFlags([PLAIN, OTHER_FLAG, FLAGGED]);

    expect(await flagOf(PLAIN)).toBeNull();
    // Controls: a pending appeal keeps its flag, and another review is not touched.
    expect(await flagOf(OTHER_FLAG)).toBe('appeal');
    expect(await flagOf(FLAGGED)).toBe('csam');
  });
});
