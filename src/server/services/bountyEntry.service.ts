import { Currency, Prisma } from '@prisma/client';
import { BountyEntryFileMeta, UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { getFilesByEntity, updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages, updateEntityImages } from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { dbRead, dbWrite } from '../db/client';
import { GetByIdInput } from '../schema/base.schema';

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
  input: { bountyId: number; userId?: number };
  select: TSelect;
  sort?: 'createdAt' | 'benefactorCount';
}) => {
  let orderBy: Prisma.BountyEntryOrderByWithRelationInput | undefined;

  if (sort === 'createdAt') {
    orderBy = { createdAt: 'desc' };
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
    where: { bountyId: input.bountyId, userId: input.userId },
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

export const upsertBountyEntry = ({
  id,
  bountyId,
  files,
  ownRights,
  images,
  description,
  userId,
}: UpsertBountyEntryInput & { userId: number }) => {
  return dbWrite.$transaction(async (tx) => {
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
        await updateEntityImages({
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
  const benefactor = await dbWrite.$transaction(
    async (tx) => {
      const entry = await tx.bountyEntry.findUniqueOrThrow({
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
      });

      if (!entry.userId) {
        throw throwBadRequestError('Entry has no user.');
      }

      if (entry.bounty.complete) {
        throw throwBadRequestError('Bounty is already complete.');
      }

      const benefactor = await tx.bountyBenefactor.findUniqueOrThrow({
        where: {
          bountyId_userId: {
            userId,
            bountyId: entry.bountyId,
          },
        },
      });

      if (benefactor.awardedToId) {
        throw throwBadRequestError('Supporters have already awarded an entry.');
      }

      const updatedBenefactor = await tx.bountyBenefactor.update({
        where: {
          bountyId_userId: {
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
            details: {
              entityId: entry.bountyId,
              entityType: 'Bounty',
            },
          });

          break;
        default: // Do no checks
          break;
      }

      await tx.bounty.update({ where: { id: entry.bountyId }, data: { complete: true } });

      // Marks as complete:
      // Use DB write to ensure data is updated correctly.
      const unawardedBountyBenefactors = await dbWrite.bountyBenefactor.findFirst({
        select: { userId: true },
        where: {
          awardedToId: null,
          bountyId: benefactor.bountyId,
        },
      });

      if (!unawardedBountyBenefactors) {
        // Update bounty as completed:
        await dbWrite.bounty.update({
          where: {
            id: benefactor.bountyId,
          },
          data: {
            complete: true,
          },
        });
      }

      return updatedBenefactor;
    },
    { maxWait: 10000, timeout: 30000 }
  );

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
  const entry = await dbRead.bountyEntry.findUniqueOrThrow({
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

  const deletedBountyEntry = await dbWrite.$transaction(async (tx) => {
    const deletedBountyEntry = await tx.bountyEntry.delete({ where: { id } });
    if (!deletedBountyEntry) return null;

    await tx.file.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
    const images = await tx.imageConnection.findMany({
      select: {
        imageId: true,
      },
      where: { entityId: id, entityType: 'BountyEntry' },
    });

    await tx.imageConnection.deleteMany({ where: { entityId: id, entityType: 'BountyEntry' } });
    await tx.image.deleteMany({ where: { id: { in: images.map((i) => i.imageId) } } });

    return deletedBountyEntry;
  });

  if (!deletedBountyEntry) return null;

  return deletedBountyEntry;
};
