import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

const cosmeticSelect = kyselyDbRead
  .selectFrom('Cosmetic')
  .select(['id', 'name', 'description', 'type', 'source', 'data', 'videoUrl']);

export type CosmeticModel = InferResult<typeof cosmeticSelect>;

export const cosmeticRepository = {
  findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(cosmeticSelect.whereRef('Cosmetic.id', '=', foreignKey).limit(1));
  },

  async findOne(id: number) {
    return await cosmeticSelect.where('id', '=', id).executeTakeFirst();
  },

  async findMany(ids: number[]) {
    return await cosmeticSelect.where('id', 'in', ids).execute();
  },
};
