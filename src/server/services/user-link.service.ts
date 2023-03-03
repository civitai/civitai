import { GetByIdInput } from './../schema/base.schema';
import { isDefined } from '~/utils/type-guards';
import { UpsertManyUserLinkParams, UpsertUserLinkParams } from './../schema/user-link.schema';

import { dbWrite, dbRead } from '~/server/db/client';
import { SessionUser } from 'next-auth';

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
  user,
}: {
  data: UpsertManyUserLinkParams;
  user?: SessionUser;
}) => {
  if (!user) return;

  const userLinkIds = data.map((x) => x.id).filter(isDefined);
  const currentUserLinks = await dbWrite.userLink.findMany({
    where: { userId: user.id },
    select: { id: true },
  });

  const withIndexes = data
    .filter((x) => x.userId === user?.id)
    .map((userLink, index) => ({ ...userLink, index }));
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
              where: { id: userLink.id },
              data: userLink,
            })
        )
      );
    }
    if (toDelete.length) {
      await tx.userLink.deleteMany({
        where: {
          id: { in: toDelete },
        },
      });
    }
  });
};

export const upsertUserLink = async ({ data }: { data: UpsertUserLinkParams }) => {
  if (!data.id) await dbWrite.userLink.create({ data });
  else await dbWrite.userLink.update({ where: { id: data.id }, data });
  // await prisma.userLink.upsert({ where: { id: data.id }, create: data, update: data });
};

export const deleteUserLink = async ({ id }: GetByIdInput) => {
  await dbWrite.userLink.delete({ where: { id } });
};
