import { Prisma } from '@prisma/client';
import { GetByIdInput } from '../schema/base.schema';
import { dbRead, dbWrite } from '../db/client';
import { UpsertBountyEntryInput } from '~/server/schema/bounty-entry.schema';
import { updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages } from '~/server/services/image.service';

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
