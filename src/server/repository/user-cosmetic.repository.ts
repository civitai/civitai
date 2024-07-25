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

  // static test(args: { ref: Expression<number>; entity: CosmeticEntity }) {
  //   return jsonArrayFrom(
  //     kyselyDbRead
  //       .selectFrom('UserCosmetic')
  //       .select((eb) => ['equippedAt', 'cosmeticId', 'obtainedAt', 'claimKey', 'UserCosmetic.data'])
  //       .innerJoin(
  //         (eb) =>
  //           eb
  //             .selectFrom('Cosmetic')
  //             .select(['id', 'name', 'description', 'type', 'source', 'data', 'videoUrl'])
  //             .where('Cosmetic.type', '=', 'ContentDecoration')
  //             .as('Cosmetic'),
  //         (join) => join.onRef('Cosmetic.id', '=', 'UserCosmetic.cosmeticId')
  //       )
  //   );
  // }

  static async findMany(userIds: number[]) {
    return await userCosmeticSelect.select(['userId']).where('userId', 'in', userIds).execute();
  }
}
