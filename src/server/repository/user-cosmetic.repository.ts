import { Expression, InferResult } from 'kysely';
import { CosmeticEntity, jsonArrayFrom, kyselyDbRead } from '~/server/kysely-db';
import { CosmeticRepository } from '~/server/repository/cosmetic.repository';

const userCosmeticSelect = kyselyDbRead
  .selectFrom('UserCosmetic')
  .select((eb) => [
    'equippedAt',
    'cosmeticId',
    'obtainedAt',
    'claimKey',
    'UserCosmetic.data',
    CosmeticRepository.findOneByIdRef(eb.ref('UserCosmetic.cosmeticId')).as('cosmetic'),
  ]);

export type UserCosmeticModel = InferResult<typeof userCosmeticSelect>;

export class UserCosmeticRepository {
  /** returns json array of UserCosmeticModel */
  static findManyByUserIdRef(ref: Expression<number>) {
    return jsonArrayFrom(userCosmeticSelect.whereRef('UserCosmetic.userId', '=', ref));
  }

  static findManyByEntityIdRef(args: { ref: Expression<number>; entity: CosmeticEntity }) {
    return jsonArrayFrom(
      userCosmeticSelect
        .whereRef('UserCosmetic.equippedToId', '=', args.ref)
        .where(({ eb, and }) => and([eb('UserCosmetic.equippedToType', '=', args.entity)]))
    );
  }

  static async findMany(userIds: number[]) {
    return await userCosmeticSelect.select(['userId']).where('userId', 'in', userIds).execute();
  }
}
