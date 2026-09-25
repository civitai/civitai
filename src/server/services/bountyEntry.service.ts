import { Prisma } from '@prisma/client';
import { Currency } from '~/shared/utils/prisma/enums';
import type {
  BountyEntryFileMeta,
  UpsertBountyEntryInput,
} from '~/server/schema/bounty-entry.schema';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  getMultiAccountTransactionsByPrefix,
} from '~/server/services/buzz.service';
import { getFilesByEntity, updateEntityFiles } from '~/server/services/file.service';
import {
  createEntityImages,
  invalidateManyImageExistence,
  updateEntityImages,
  enqueueImageIngestion,
} from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { dbRead, dbWrite } from '../db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import type { GetByIdInput } from '../schema/base.schema';
import { userBountyEntryCountCache } from '~/server/redis/caches';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { logToAxiom } from '~/server/logging/client';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { lockBountyForPayout } from '~/server/services/bounty-payout-lock';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';

export const getEntryById = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
}: {
  input: GetByIdInput;
  select: TSelect;
}) => {
  return dbRead.bountyEntry.findUnique({ where: { id: input.id }, select });
};

export const getAllEntriesByBountyId = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
  sort = 'createdAt',
}: {
  input: {
    bountyId: number;
    userId?: number;
    excludedUserIds?: number[];
    limit?: number;
    cursor?: number;
  };
  select: TSelect;
  sort?: 'createdAt' | 'benefactorCount';
}) => {
  let orderBy: Prisma.BountyEntryOrderByWithRelationInput | undefined;
  const take = (input.limit ?? 20) + 1;

  if (sort === 'createdAt') {
    orderBy = { id: 'desc' };
  } else if (sort === 'benefactorCount') {
    orderBy = {
      benefactors: {
        _count: 'desc',
      },
    };
  } else {
    orderBy = undefined;
  }

  return dbRead.bountyEntry.findMany({
    where: {
      bountyId: input.bountyId,
      userId: input.userId,
      AND: input.excludedUserIds ? [{ userId: { notIn: input.excludedUserIds } }] : undefined,
    },
    cursor: input.cursor ? { id: input.cursor } : undefined,
    take,
    select,
    orderBy,
  });
};

export const getBountyEntryEarnedBuzz = async ({
  ids,
  currency = Currency.BUZZ,
}: {
  ids: number[];
  currency?: Currency;
}) => {
  if (!ids.length) {
    return [];
  }

  const data = await dbRead.$queryRaw<{ id: number; awardedUnitAmount: number }[]>`
    SELECT
        be.id,
        COALESCE(SUM(bb."unitAmount"), 0) AS "awardedUnitAmount"
    FROM "BountyEntry" be
    LEFT JOIN "BountyBenefactor" bb ON bb."awardedToId" = be.id AND bb.currency = ${currency}::"Currency"
    WHERE be.id IN (${Prisma.join(ids)})
    GROUP BY be.id
  `;

  return data;
};

export const upsertBountyEntry = async ({
  id,
  bountyId,
  files,
  ownRights,
  images,
  description,
  userId,
}: UpsertBountyEntryInput & { userId: number }) => {
  await throwOnBlockedUserContent(description, { surface: 'bountyEntry' });

  let imagesToIngest: IngestImageInput[] = [];

  const result = await dbWrite.$transaction(async (tx) => {
    if (id) {
      const [awarded] = await getBountyEntryEarnedBuzz({ ids: [id] });

      if (awarded && awarded.awardedUnitAmount > 0) {
        throw throwBadRequestError('Bounty entry has already been awarded and cannot be updated');
      }
      // confirm it exists:
      const entry = await tx.bountyEntry.update({ where: { id }, data: { description } });
      if (!entry) return null;

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: entry.id,
          entityType: 'BountyEntry',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        imagesToIngest = await updateEntityImages({
          images,
          tx,
          userId,
          entityId: entry.id,
          entityType: 'BountyEntry',
        });
      }

      return entry;
    } else {
      const entry = await tx.bountyEntry.create({
        data: {
          bountyId,
          userId,
          description,
        },
      });

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: entry.id,
          entityType: 'BountyEntry',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        imagesToIngest = await createEntityImages({
          images,
          tx,
          userId,
          entityId: entry.id,
          entityType: 'BountyEntry',
        });
      }

      return entry;
    }
  });

  // Count-cache refresh hits Redis — run after commit, off the txn budget.
  // Only on create (!id): updating an entry's description doesn't change the
  // user's entry count, so the update path never refreshed it (and shouldn't).
  // (result is BountyEntry | null — the txn returns null when an update finds nothing.)
  if (!id && result?.userId) {
    await userBountyEntryCountCache.refresh(result.userId);
  }

  enqueueImageIngestion({
    images: imagesToIngest,
    name: 'bounty-entry-image-ingest',
    userId,
  });
  if (result && description !== undefined)
    scanEntityInBackground({ entityType: 'BountyEntry', entityId: result.id });

  return result;
};

export const awardBountyEntry = async ({ id, userId }: { id: number; userId: number }) => {
  const logData = { entryId: id, userId, bountyId: 0 };
  const log = (type: 'info' | 'error', message: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({ ...logData, name: 'bounty-award', type, message, ...extra }).catch(() => null);

  await log('info', 'Award bounty entry started');

  const { entry, benefactor } = await dbWrite.$transaction(
    async (tx) => {
      const entry = await tx.bountyEntry.findUniqueOrThrow({
        where: { id },
        select: { id: true, bountyId: true, userId: true },
      });
      logData.bountyId = entry.bountyId;

      if (!entry.userId) {
        log('error', 'Entry has no user');
        throw throwBadRequestError('Entry has no user.');
      }

      // A void or refund that claimed the bounty first holds this lock until it commits, and
      // then reads complete here.
      const bounty = await lockBountyForPayout(tx, entry.bountyId);
      if (!bounty || bounty.complete || bounty.refunded) {
        log('error', 'Bounty already complete', { refunded: bounty?.refunded });
        throw throwBadRequestError('Bounty is already complete.');
      }

      const benefactor = await tx.bountyBenefactor.findUniqueOrThrow({
        where: { bountyId_userId: { userId, bountyId: entry.bountyId } },
      });
      if (benefactor.awardedToId) {
        log('error', 'Benefactor already awarded an entry', {
          previouslyAwardedEntryId: benefactor.awardedToId,
        });
        throw throwBadRequestError('Supporters have already awarded an entry.');
      }

      const updatedBenefactor = await tx.bountyBenefactor.update({
        where: { bountyId_userId: { userId, bountyId: entry.bountyId } },
        data: { awardedToId: entry.id, awardedAt: new Date() },
      });

      const unawardedBountyBenefactors = await tx.bountyBenefactor.findFirst({
        select: { userId: true },
        where: { awardedToId: null, bountyId: entry.bountyId },
      });
      if (!unawardedBountyBenefactors) {
        await tx.bounty.update({ where: { id: entry.bountyId }, data: { complete: true } });
        log('info', 'All benefactors have awarded - bounty marked complete');
      }

      return { entry: { ...entry, userId: entry.userId }, benefactor: updatedBenefactor };
    },
    { maxWait: 10000, timeout: 30000 }
  );

  try {
    await payBountyAward({
      entryId: id,
      bountyId: entry.bountyId,
      winnerUserId: entry.userId,
      benefactor,
      log,
    });
  } catch (e) {
    // The award is committed; the Buzz is owed and has to be reconciled by hand.
    await log('error', 'Award committed but the Buzz payout failed', {
      bountyId: entry.bountyId,
      amount: benefactor.unitAmount,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  await log('info', 'Award bounty entry completed successfully', {
    awardedAmount: benefactor.unitAmount,
    currency: benefactor.currency,
  });

  return benefactor;
};

async function payBountyAward({
  entryId,
  bountyId,
  winnerUserId,
  benefactor,
  log,
}: {
  entryId: number;
  bountyId: number;
  winnerUserId: number;
  benefactor: { currency: Currency; unitAmount: number; buzzTransactionId: string[] };
  log: (type: 'info' | 'error', message: string, extra?: Record<string, unknown>) => unknown;
}) {
  if (benefactor.currency !== Currency.BUZZ) return;

  if (!benefactor.buzzTransactionId || benefactor.buzzTransactionId.length === 0) {
    // Legacy rows carry no transaction ids.
    await createBuzzTransaction({
      fromAccountId: 0,
      toAccountId: winnerUserId,
      amount: benefactor.unitAmount,
      type: TransactionType.Bounty,
      description: 'Reason: Bounty entry has been awarded!',
      details: { entityId: bountyId, entityType: 'Bounty' },
    });
    log('info', 'Single buzz transaction created (no recorded transaction IDs)', {
      amount: benefactor.unitAmount,
    });
    return;
  }

  const txResults = await Promise.allSettled(
    benefactor.buzzTransactionId.map((txId) => getMultiAccountTransactionsByPrefix(txId))
  );
  txResults.forEach((result, index) => {
    if (result.status === 'rejected')
      log('error', 'Transaction lookup failed', {
        txId: benefactor.buzzTransactionId[index],
        error: result.reason,
      });
  });

  const awardedAmounts = txResults.reduce<Partial<Record<BuzzAccountType, number>>>(
    (acc, result) => {
      if (result.status === 'fulfilled' && result.value) {
        result.value.forEach((t) => {
          const accountType = t.accountType as BuzzAccountType;
          acc[accountType] = (acc[accountType] || 0) + t.amount;
        });
      }
      return acc;
    },
    {}
  );
  if (Object.keys(awardedAmounts).length === 0)
    throw throwBadRequestError('No valid transactions found for multi-account award');

  await createBuzzTransactionMany(
    Object.keys(awardedAmounts).map((accountType) => ({
      fromAccountId: 0,
      toAccountId: winnerUserId,
      toAccountType: accountType as BuzzAccountType,
      amount: awardedAmounts[accountType as BuzzAccountType] || 0,
      type: TransactionType.Bounty,
      description: 'Reason: Bounty entry has been awarded!',
      details: { entityId: bountyId, entityType: 'Bounty' },
      externalTransactionId: `bounty-award-${entryId}-${accountType}`,
    }))
  );
  log('info', 'All multi-account buzz transactions created (batched)', {
    transactionIdCount: benefactor.buzzTransactionId.length,
    accountTypes: Object.keys(awardedAmounts).length,
  });
}

export const getBountyEntryFilteredFiles = async ({
  id,
  userId,
  isModerator,
}: {
  id: number;
  userId?: number;
  isModerator?: boolean;
}) => {
  const bountyEntryFindArgs = {
    where: { id },
    select: {
      id: true,
      userId: true,
      bountyId: true,
    },
  } as const;
  const bountyEntry = await dbRead.bountyEntry.findUniqueOrThrow(bountyEntryFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'bountyEntry', caller: 'getBountyEntryFilteredFiles' });
    return dbWrite.bountyEntry.findUniqueOrThrow(bountyEntryFindArgs);
  });

  const files = await getFilesByEntity({ id: bountyEntry.id, type: 'BountyEntry' });

  if (bountyEntry.userId === userId || isModerator) {
    // Owner can see all files.
    return files.map((f) => ({
      ...f,
      metadata: f.metadata as BountyEntryFileMeta,
    }));
  }
  const benefactor = !userId
    ? null
    : await dbRead.bountyBenefactor.findUnique({
        where: {
          bountyId_userId: {
            userId,
            bountyId: bountyEntry.bountyId,
          },
        },
        select: {
          awardedToId: true,
          currency: true,
        },
      });

  const [awardedBounty] = await getBountyEntryEarnedBuzz({
    ids: [bountyEntry.id],
    currency: benefactor?.currency ?? Currency.BUZZ,
  });

  return files.map((f) => {
    const details = f.metadata as BountyEntryFileMeta;
    // TODO: Once we support Tipping entries - we need to check if a tipConnection is created
    let hasFullAccess = details.benefactorsOnly ? benefactor?.awardedToId === bountyEntry.id : true;

    if (awardedBounty.awardedUnitAmount < (details.unlockAmount ?? 0)) {
      hasFullAccess = false;
    }

    return {
      ...f,
      url: hasFullAccess ? f.url : null,
      metadata: f.metadata as BountyEntryFileMeta,
    };
  });
};

export const deleteBountyEntry = async ({
  id,
  isModerator,
}: {
  id: number;
  isModerator: boolean;
}) => {
  const entryFindArgs = {
    where: { id },
    select: {
      id: true,
      bountyId: true,
      userId: true,
      bounty: {
        select: {
          complete: true,
        },
      },
    },
  } as const;
  const entry = await dbRead.bountyEntry.findUniqueOrThrow(entryFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'bountyEntry', caller: 'deleteBountyEntry' });
    return dbWrite.bountyEntry.findUniqueOrThrow(entryFindArgs);
  });

  if (!entry) {
    throw throwBadRequestError('Bounty entry does not exist');
  }

  if (!isModerator) {
    const [award] = await getBountyEntryEarnedBuzz({ ids: [entry.id] });

    if (award.awardedUnitAmount > 0) {
      throw throwBadRequestError(
        'This bounty entry has been awarded by some users and as such, cannot be deleted.'
      );
    }
  }

  const deletedBountyEntry = await dbWrite.$transaction(
    async (tx) => {
      const deletedBountyEntry = await tx.bountyEntry.delete({ where: { id } });
      if (!deletedBountyEntry) return null;

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
      const images = await tx.imageConnection.findMany({
        select: { imageId: true },
        where: { entityId: id, entityType: 'BountyEntry' },
      });

      await tx.imageConnection.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
      const imageIds = images.map((i) => i.imageId);
      await Promise.all([
        tx.image.deleteMany({ where: { id: { in: imageIds } } }),
        invalidateManyImageExistence(imageIds),
      ]);

      return deletedBountyEntry;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  if (!deletedBountyEntry) return null;

  return deletedBountyEntry;
};
