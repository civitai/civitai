import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, kyselyDbRead } from '~/server/kysely-db';
import { cosmeticRepository } from '~/server/repository/cosmetic.repository';

const userCosmeticSelect = kyselyDbRead
  .selectFrom('UserCosmetic')
  .select((eb) => [
    'equippedAt',
    'cosmeticId',
    'obtainedAt',
    'claimKey',
    'UserCosmetic.data',
    cosmeticRepository.findOneByIdRef(eb.ref('UserCosmetic.cosmeticId')).as('cosmetic'),
  ]);

export type UserCosmeticModel = InferResult<typeof userCosmeticSelect>;

export const userCosmeticRepository = {
  /** returns json array of UserCosmeticModel */
  findManyByUserIdRef(foreignKey: Expression<number>) {
    return jsonArrayFrom(userCosmeticSelect.whereRef('UserCosmetic.userId', '=', foreignKey));
  },
  async findMany(userIds: number[]) {
    return await userCosmeticSelect.select(['userId']).where('userId', 'in', userIds).execute();
  },
};
