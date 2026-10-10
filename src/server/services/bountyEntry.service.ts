import { Prisma } from '@prisma/client';
import { Currency } from '~/shared/utils/prisma/enums';
import type {
  BountyEntryFileMeta,
  UpsertBountyEntryInput,
} from '~/server/schema/bounty-entry.schema';
import { getFilesByEntity, updateEntityFiles } from '~/server/services/file.service';
import {
  invalidateManyImageExistence,
  enqueueImageIngestion,
} from '~/server/services/image.service';
import { createEntityImages, updateEntityImages } from '~/server/services/image-entity.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { dbRead, dbWrite } from '../db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import type { GetByIdInput } from '../schema/base.schema';
import { userBountyEntryCountCache } from '~/server/redis/caches';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { logToAxiom } from '~/server/logging/client';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { isPayoutPending, lockBountyForPayout } from '~/server/services/bounty-payout-lock';
import { settleBountyPayout, refundUnpayableBountyAward } from '~/server/services/bounty.service';
import { isTextScanPoiHidden } from '~/server/services/text-scan/flag-snapshot';
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

      if (entry.userId === userId) {
        throw throwBadRequestError("You can't award your own entry.");
      }

      // A refund that claimed the bounty first holds this lock until it commits, and
      // then reads complete here.
      const bounty = await lockBountyForPayout(tx, entry.bountyId);
      if (!bounty || bounty.complete || bounty.refunded) {
        log('error', 'Bounty already complete', { refunded: bounty?.refunded });
        throw throwBadRequestError('Bounty is already complete.');
      }
      if (isTextScanPoiHidden(bounty)) {
        log('error', 'Bounty is hidden pending review');
        throw throwBadRequestError('This bounty is hidden pending review and cannot be awarded.');
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
      // Settlement pays from these marks; see the invariant on `refundUnpayableBountyAward`.
      await tx.bounty.update({
        where: { id: entry.bountyId },
        data: {
          payoutRecordedAt: new Date(),
          payoutWinnerUserId: entry.userId,
          ...(unawardedBountyBenefactors ? {} : { complete: true }),
        },
      });
      if (!unawardedBountyBenefactors)
        log('info', 'All benefactors have awarded - bounty marked complete');

      return { entry: { ...entry, userId: entry.userId }, benefactor: updatedBenefactor };
    },
    { maxWait: 10000, timeout: 30000 }
  );

  if (!(await settleBountyPayout(entry.bountyId, { firstAttempt: true })))
    await log('error', 'Award recorded but the Buzz payout failed; the retry job pays it', {
      bountyId: entry.bountyId,
      amount: benefactor.unitAmount,
    });

  await log('info', 'Award bounty entry completed', {
    awardedAmount: benefactor.unitAmount,
    currency: benefactor.currency,
  });

  return benefactor;
};

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

  // Checked on the primary under the payout lock, so an award recorded concurrently is seen. An
  // unsettled payout is settled before the entry goes; a moderator may go past one that no retry
  // can pay (see `refundUnpayableBountyAward`).
  const deleteEntry = (evenIfPending = false) =>
    dbWrite.$transaction(
      async (tx) => {
        const locked = await lockBountyForPayout(tx, entry.bountyId);
        if (!evenIfPending && locked && isPayoutPending(locked)) return PAYOUT_PENDING;
        return deleteEntryRows(tx, id);
      },
      { maxWait: 10000, timeout: 30000 }
    );

  let deleted = await deleteEntry();
  if (deleted === PAYOUT_PENDING) {
    if (await settleBountyPayout(entry.bountyId)) deleted = await deleteEntry();
    else if (isModerator && (await refundUnpayableBountyAward(entry.bountyId)))
      deleted = await deleteEntry(true);
  }
  if (deleted === PAYOUT_PENDING)
    throw throwBadRequestError(
      'This bounty has a payout still pending, so its entries cannot be deleted yet. Try again later.'
    );
  if (!deleted) return null;
  await invalidateManyImageExistence(deleted.imageIds);
  return deleted.entry;
};

const PAYOUT_PENDING = Symbol('payout-pending');

async function deleteEntryRows(tx: Prisma.TransactionClient, id: number) {
  const entry = await tx.bountyEntry.delete({ where: { id } });
  if (!entry) return null;

  await tx.file.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
  const images = await tx.imageConnection.findMany({
    select: { imageId: true },
    where: { entityId: id, entityType: 'BountyEntry' },
  });

  await tx.imageConnection.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
  const imageIds = images.map((i) => i.imageId);
  await tx.image.deleteMany({ where: { id: { in: imageIds } } });

  return { entry, imageIds };
}
