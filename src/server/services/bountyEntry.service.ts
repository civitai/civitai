import { Currency, Prisma } from '@prisma/client';
import { GetByIdInput } from '../schema/base.schema';
import { dbRead, dbWrite } from '../db/client';
import { UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages } from '~/server/services/image.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';

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
        COALESCE(SUM(bb."unitAmount"), 0) AS awardedUnitAmount
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
      select: { id: true, bountyId: true },
    });

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

    return updatedBenefactor;
  });

  return benefactor;
};
