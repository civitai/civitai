import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A second appeal on an image, end to end through the fee: the real handler, the real
 * service, and an Appeal table that enforces the same unique indexes as the database.
 *
 * Before this was fixed, an image that was approved on appeal and later blocked again could
 * never be appealed: the fee was charged, the insert hit the (entityType, entityId, userId)
 * unique index, and the fee was refunded in the same second.
 */

const { mockCharge, mockRefund } = vi.hoisted(() => ({
  mockCharge: vi.fn(),
  mockRefund: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCharge,
  refundMultiAccountTransaction: mockRefund,
}));

import { createEntityAppealHandler } from '../report.controller';
import { isSafeToRetry } from '@civitai/buzz';
import { APPEAL_ALREADY_DECIDED, APPEAL_ALREADY_PENDING } from '~/shared/utils/appeal';
import { AppealStatus, EntityType } from '~/shared/utils/prisma/enums';

const OWNER = 602767;
const IMAGE_ID = 99;
const KEY = ['entityType', 'entityId', 'userId'] as const;

type AppealRow = {
  id: number;
  entityType: EntityType;
  entityId: number;
  userId: number;
  status: AppealStatus;
  buzzTransactionId: string | null;
};

let appeals: AppealRow[];

// Read from the generated client rather than restated, so the fake enforces whatever composite
// @@unique schema.full.prisma declares on Appeal (single-field @unique is not read; Appeal has
// none). The Pending-only index exists only in the migration SQL, because Prisma cannot express a
// partial index, so that one is restated here and pinned against the SQL below.
const declaredUniques = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Appeal')!
  .uniqueFields as (keyof AppealRow)[][];

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`entityType`,`entityId`,`userId`)',
    { code: 'P2002', clientVersion: Prisma.prismaVersion.client }
  );
}

function seed(...statuses: AppealStatus[]) {
  appeals = statuses.map((status, i) => ({
    id: i + 1,
    entityType: EntityType.Image,
    entityId: IMAGE_ID,
    userId: OWNER,
    status,
    buzzTransactionId: null,
  }));
}

const blockedImage = (overrides: Record<string, unknown> = {}) => ({
  id: IMAGE_ID,
  userId: OWNER,
  blockedFor: 'moderated',
  needsReview: null,
  ingestion: 'Blocked',
  ...overrides,
});

const appeal = () =>
  createEntityAppealHandler({
    input: { entityId: IMAGE_ID, entityType: EntityType.Image, message: 'Blocked again.' },
    ctx: { user: { id: OWNER }, features: { isGreen: false } } as never,
  });

beforeEach(() => {
  vi.clearAllMocks();
  seed();

  dbMock.dbRead.image.findUnique.mockResolvedValue(blockedImage());
  // Past the free allowance, so every appeal here carries the fee.
  dbMock.dbRead.appeal.count.mockResolvedValue(3);
  dbMock.dbRead.appeal.findFirst.mockImplementation(
    async ({
      where,
      orderBy,
    }: {
      where: Partial<AppealRow>;
      orderBy?: { id?: 'asc' | 'desc' };
    }) => {
      if (!orderBy?.id) throw new Error('fake findFirst: expected an orderBy on id');
      const direction = orderBy.id === 'desc' ? -1 : 1;
      return (
        appeals
          .filter((a) => KEY.every((k) => a[k] === where[k]))
          .sort((a, b) => direction * (a.id - b.id))[0] ?? null
      );
    }
  );
  dbMock.dbWrite.appeal.create.mockImplementation(
    async ({ data }: { data: Omit<AppealRow, 'id' | 'status'> }) => {
      const row: AppealRow = { id: appeals.length + 1, status: AppealStatus.Pending, ...data };
      const clashes = (fields: (keyof AppealRow)[], others: AppealRow[]) =>
        others.some((a) => fields.every((f) => a[f] === row[f]));
      if (declaredUniques.some((fields) => clashes(fields, appeals))) throw uniqueViolation();
      const pending = appeals.filter((a) => a.status === AppealStatus.Pending);
      if (clashes([...KEY], pending)) throw uniqueViolation();
      appeals.push(row);
      return row;
    }
  );

  // The image row the appeal flags; refusing a flagged image is image-appeal-review-flag's subject.
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);

  mockCharge.mockResolvedValue({ transactionCount: 1 });
  mockRefund.mockResolvedValue(undefined);
});

describe('a second appeal on the same image', () => {
  it('charges once and records a new appeal when an approved image has been blocked again', async () => {
    seed(AppealStatus.Approved);

    await expect(appeal()).resolves.toMatchObject({ status: AppealStatus.Pending });

    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(appeals.map((a) => a.status)).toEqual([AppealStatus.Approved, AppealStatus.Pending]);
    expect(appeals[1].buzzTransactionId).toMatch(/^appeal-602767-/);
  });

  // Product decision (2026-10-02): one appeal per block. A rejection upheld the block that is
  // still in place, so asking again is refused, and refused before the fee is charged.
  it('refuses an appeal of a block that was already upheld on appeal, without charging', async () => {
    seed(AppealStatus.Rejected);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_DECIDED,
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(1);
  });

  // Submitting an appeal sets needsReview = 'appeal', which also fails eligibility; the pending
  // check runs first so the owner is told why.
  it('refuses while an appeal is still pending, without charging', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);
    dbMock.dbRead.image.findUnique.mockResolvedValue(blockedImage({ needsReview: 'appeal' }));

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(2);
  });

  it('refunds the fee it charged when a concurrent submit took the pending slot first', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);
    // The guard's read misses the other request's row; the index is what catches it.
    dbMock.dbRead.appeal.findFirst.mockResolvedValueOnce(null);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    // Deliberate: the client retries every failure by default, and retrying a refund that timed
    // out can refund twice. Do not drop this to the default; a refund that did not land is logged.
    expect(mockRefund.mock.calls[0][1]).toEqual({ shouldRetry: isSafeToRetry });
    expect(mockRefund.mock.calls[0][0].externalTransactionIdPrefix).toBe(
      mockCharge.mock.calls[0][0].externalTransactionIdPrefix
    );
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'create-entity-appeal' })
    );
    expect(appeals).toHaveLength(2);
  });

  it('tells a free appeal that lost the race it is already pending, charging nothing', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);
    dbMock.dbRead.appeal.count.mockResolvedValue(0);
    dbMock.dbRead.appeal.findFirst.mockResolvedValueOnce(null);

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(mockRefund).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(2);
  });

  // A losing submit refunds by its fee prefix; a prefix shared with the winner would refund both.
  it('gives each charge its own refund prefix, even within the same millisecond', async () => {
    const clock = vi.spyOn(Date.prototype, 'getTime').mockReturnValue(1_790_000_000_000);
    try {
      seed(AppealStatus.Approved);
      await appeal();
      seed(AppealStatus.Approved);
      await appeal();
    } finally {
      clock.mockRestore();
    }

    const [first, second] = mockCharge.mock.calls.map(
      ([input]) => input.externalTransactionIdPrefix
    );
    expect(first).toMatch(/^appeal-602767-1790000000000-/);
    // Refunds look transactions up by prefix, so neither may be a prefix of the other.
    expect(second.startsWith(first) || first.startsWith(second)).toBe(false);
  });

  // Older rows carry blockedFor 'moderated' with ingestion 'Scanned'; the page offers them an appeal.
  it('accepts a moderator block whose ingestion was never set to Blocked', async () => {
    seed(AppealStatus.Approved);
    dbMock.dbRead.image.findUnique.mockResolvedValue(blockedImage({ ingestion: 'Scanned' }));

    await expect(appeal()).resolves.toMatchObject({ status: AppealStatus.Pending });
  });

  it.each([
    ['not blocked', { blockedFor: null }],
    ['blocked for another reason', { blockedFor: 'AiNotVerified' }],
    ['held for another review', { needsReview: 'minor' }],
  ])('refuses an image that is %s, without charging', async (_, overrides) => {
    seed(AppealStatus.Approved);
    dbMock.dbRead.image.findUnique.mockResolvedValue(blockedImage(overrides));

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only an image blocked by moderators can be appealed',
    });

    expect(mockCharge).not.toHaveBeenCalled();
    expect(appeals).toHaveLength(1);
  });

  it('still refunds and reports the original error when the create fails for another reason', async () => {
    dbMock.dbWrite.appeal.create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(appeal()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'connection reset',
    });

    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockRefund.mock.calls[0][0].externalTransactionIdPrefix).toBe(
      mockCharge.mock.calls[0][0].externalTransactionIdPrefix
    );
  });

  it('logs the fee as owed, and keeps the original error, when the refund itself fails', async () => {
    seed(AppealStatus.Approved, AppealStatus.Pending);
    dbMock.dbRead.appeal.findFirst.mockResolvedValueOnce(null);
    mockRefund.mockRejectedValue(new Error('buzz unavailable'));

    await expect(appeal()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APPEAL_ALREADY_PENDING,
    });

    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'create-entity-appeal',
        userId: OWNER,
        buzzTransactionId: mockCharge.mock.calls[0][0].externalTransactionIdPrefix,
      })
    );
  });
});

// The race test above relies on the fake's restatement of this index; this ties it to the SQL.
it('the migration makes only Pending appeals unique per entity and user', () => {
  const sql = readFileSync(
    path.join(
      __dirname,
      '../../../../packages/civitai-db-schema/prisma/migrations/20261002200000_appeal_one_pending_per_entity/migration.sql'
    ),
    'utf8'
  );

  expect(sql).toMatch(
    /^CREATE UNIQUE INDEX "Appeal_entityType_entityId_userId_pending_key" ON "Appeal"\("entityType", "entityId", "userId"\) WHERE status = 'Pending';$/m
  );
  expect(sql).toMatch(/^DROP INDEX "Appeal_entityType_entityId_userId_key";$/m);
});
