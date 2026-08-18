import { dbRead, dbWrite } from '~/server/db/client';
import type { SetUserHubOrderInput, UpsertUserHubInput } from '~/server/schema/user-hub.schema';
import { hubLimits } from '~/server/schema/user-hub.schema';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';

const hubSelect = {
  id: true,
  name: true,
  index: true,
  sort: true,
  period: true,
  mediaTypes: true,
  sources: {
    select: { id: true, type: true, targetId: true, alias: true, enabled: true, index: true },
    orderBy: { index: 'asc' },
  },
} as const;

export type UserHubDetail = Awaited<ReturnType<typeof getUserHubs>>[number];

export async function getUserHubs({ userId }: { userId: number }) {
  return dbRead.userHub.findMany({
    where: { userId },
    select: hubSelect,
    orderBy: { index: 'asc' },
  });
}

// Every read is scoped by userId rather than checked after the fetch, so an id
// belonging to someone else is a not-found rather than a leak.
export async function getUserHubById({ id, userId }: { id: number; userId: number }) {
  const hub = await dbRead.userHub.findFirst({ where: { id, userId }, select: hubSelect });
  if (!hub) throw throwNotFoundError('Hub not found');
  return hub;
}

export async function upsertUserHub({ userId, ...input }: UpsertUserHubInput & { userId: number }) {
  const { id, sources, ...data } = input;

  const duplicate = new Set<string>();
  for (const source of sources) {
    const key = `${source.type}:${source.targetId}`;
    if (duplicate.has(key)) throw throwBadRequestError('A source was added twice');
    duplicate.add(key);
  }

  if (!id) {
    const count = await dbRead.userHub.count({ where: { userId } });
    if (count >= hubLimits.hubsPerUser)
      throw throwBadRequestError(`You can have at most ${hubLimits.hubsPerUser} hubs`);

    return dbWrite.userHub.create({
      data: {
        ...data,
        userId,
        index: count,
        sources: { create: sources.map(({ id: _, ...source }) => source) },
      },
      select: hubSelect,
    });
  }

  const existing = await dbRead.userHub.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw throwNotFoundError('Hub not found');

  return dbWrite.$transaction(async (tx) => {
    await tx.userHubSource.deleteMany({ where: { hubId: id } });
    return tx.userHub.update({
      where: { id },
      data: { ...data, sources: { create: sources.map(({ id: _, ...source }) => source) } },
      select: hubSelect,
    });
  });
}

export async function deleteUserHub({ id, userId }: { id: number; userId: number }) {
  const { count } = await dbWrite.userHub.deleteMany({ where: { id, userId } });
  if (!count) throw throwNotFoundError('Hub not found');
}

export async function setUserHubOrder({ ids, userId }: SetUserHubOrderInput & { userId: number }) {
  const owned = await dbRead.userHub.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  if (owned.length !== ids.length) throw throwNotFoundError('Hub not found');

  await dbWrite.$transaction(
    ids.map((id, index) => dbWrite.userHub.update({ where: { id }, data: { index } }))
  );
}
