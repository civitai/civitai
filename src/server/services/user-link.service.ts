import { GetByIdInput } from './../schema/base.schema';
import { isDefined } from '~/utils/type-guards';
import { UpsertManyUserLinkParams, UpsertUserLinkParams } from './../schema/user-link.schema';

import { dbWrite, dbRead } from '~/server/db/client';

export const getUserLinks = async ({ userId }: { userId: number }) => {
  return await dbRead.userLink.findMany({
    where: { userId },
    select: {
      id: true,
      url: true,
      type: true,
    },
  });
};

export const upsertManyUserLinks = async ({
  data,
  userId,
}: {
  data: UpsertManyUserLinkParams;
  userId: number;
}) => {
  const userLinkIds = data.map((x) => x.id).filter(isDefined);
  const currentUserLinks = await dbWrite.userLink.findMany({
    where: { userId: userId },
    select: { id: true },
  });

  const withIndexes = data.map((userLink, index) => ({ ...userLink, index, userId }));
  const toCreate = withIndexes.filter((x) => !x.id);
  const toUpdate = withIndexes.filter((x) => !!x.id);
  const toDelete = currentUserLinks.filter((x) => !userLinkIds.includes(x.id)).map((x) => x.id);

  await dbWrite.$transaction(async (tx) => {
    if (toCreate.length) {
      await tx.userLink.createMany({ data: toCreate });
    }
    if (toUpdate.length) {
      await Promise.all(
        toUpdate.map(
          async (userLink) =>
            await tx.userLink.updateMany({
              where: { id: userLink.id, userId },
              data: userLink,
            })
        )
      );
    }
    if (toDelete.length) {
      await tx.userLink.deleteMany({
        where: {
          id: { in: toDelete },
          userId,
        },
      });
    }
  });
};

export const upsertUserLink = async (data: UpsertUserLinkParams & { userId: number }) => {
  if (!data.id) await dbWrite.userLink.create({ data });
  else await dbWrite.userLink.update({ where: { id: data.id, userId: data.userId }, data });
};

export const deleteUserLink = async ({ id, userId }: GetByIdInput & { userId: number }) => {
  await dbWrite.userLink.delete({ where: { id, userId } });
};
