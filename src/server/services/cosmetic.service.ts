import dayjs from 'dayjs';
import { dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';

export async function getCosmeticDetail({ id }: GetByIdInput) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
  });

  return cosmetic;
}

export async function isCosmeticAvailable(id: number, userId?: number) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
    select: { availableStart: true, availableEnd: true, availableQuery: true },
  });
  if (!cosmetic) throw new Error("That cosmetic doesn't exist");

  if (!dayjs().isBetween(cosmetic.availableStart, cosmetic.availableEnd)) return false;
  else if (cosmetic.availableQuery) {
    if (!userId) return false;

    // If the cosmetic has a query, check if the user is eligible
    const result = await dbRead.$queryRawUnsafe<{ available: boolean }[]>(
      cosmetic.availableQuery.replace(/\$\{userId\}/g, `${userId}`)
    );
    if (!result[0].available) return false;
  }

  return true;
}
