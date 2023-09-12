import { Currency, Prisma } from '@prisma/client';
import { GetByIdInput } from '../schema/base.schema';
import { dbRead, dbWrite } from '../db/client';
import { BountyEntryFileMeta, UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { getFilesByEntity, updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages } from '~/server/services/image.service';
import { throwBadRequestError, throwInsufficientFundsError } from '~/server/utils/errorHandling';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';

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
}: {
  input: { bountyId: number };
  select: TSelect;
}) => {
  return dbRead.bountyEntry.findMany({
    where: { bountyId: input.bountyId },
    select,
  });
};

export const getBountyEntryEarnedBuzz = async ({
  ids,
  currency = Currency.BUZZ,
}: {
  ids: number[];
  currency?: Currency;
}) => {
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
  images,
  userId,
}: UpsertBountyEntryInput & { userId: number }) => {
  return await dbWrite.$transaction(async (tx) => {
    if (id) {
      // confirm it exists:
      const entry = await tx.bountyEntry.findUniqueOrThrow({ where: { id } });

      if (files) {
        await updateEntityFiles({ tx, entityId: entry.id, entityType: 'BountyEntry', files });
      }

      if (images) {
        await createEntityImages({
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
        },
      });
      if (files) {
        await updateEntityFiles({ tx, entityId: entry.id, entityType: 'BountyEntry', files });
      }
      if (images) {
        await createEntityImages({
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
};

export const awardBountyEntry = async ({ id, userId }: { id: number; userId: number }) => {
  const benefactor = await dbWrite.$transaction(async (tx) => {
    const entry = await tx.bountyEntry.findUniqueOrThrow({
      where: { id },
      select: { id: true, bountyId: true, userId: true },
    });

    if (!entry.userId) {
      throw throwBadRequestError('Entry has no user.');
    }

    const benefactor = await tx.bountyBenefactor.findUniqueOrThrow({
      where: {
        userId_bountyId: {
          userId,
          bountyId: entry.bountyId,
        },
      },
    });

    if (benefactor.awardedToId) {
      throw throwBadRequestError('Benefactor has already awarded an entry.');
    }

    const updatedBenefactor = await tx.bountyBenefactor.update({
      where: {
        userId_bountyId: {
          userId,
          bountyId: entry.bountyId,
        },
      },
      data: {
        awardedToId: entry.id,
        awardedAt: new Date(),
      },
    });

    switch (updatedBenefactor.currency) {
      case Currency.BUZZ:
        await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: entry.userId,
          amount: updatedBenefactor.unitAmount,
          type: TransactionType.Bounty,
          description: 'Reason: Bounty entry has been awarded!',
        });

        break;
      default: // Do no checks
        break;
    }

    const unawardedBountyBenefactors = await dbRead.bountyBenefactor.findFirst({
      select: { userId: true },
      where: {
        awardedToId: null,
        bountyId: entry.bountyId,
      },
    });

    if (!unawardedBountyBenefactors) {
      // Update bounty as completed:
      await tx.bounty.update({
        where: {
          id: entry.bountyId,
        },
        data: {
          complete: true,
        },
      });
    }

    return updatedBenefactor;
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
  const bountyEntry = await dbRead.bountyEntry.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      userId: true,
      bountyId: true,
    },
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
          userId_bountyId: {
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
