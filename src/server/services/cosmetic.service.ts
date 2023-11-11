import { dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';

export async function getCosmeticDetail({ id }: GetByIdInput) {
  const cosmetic = await dbRead.cosmetic.findUnique({
    where: { id },
  });
  return cosmetic;
}
