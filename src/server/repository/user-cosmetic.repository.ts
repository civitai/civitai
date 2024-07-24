import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, kyselyDbRead } from '~/server/kysely-db';
import { cosmeticRepository } from '~/server/repository/cosmetic.repository';
import { Repository, derived } from '~/server/repository/infrastructure/repository';

type Views = 'public' | 'private';
type Options<T extends Views> = { select?: T };

class UserCosmeticRepository extends Repository {
  private get publicUserCosmeticSelect() {
    return this.dbRead
      .selectFrom('UserCosmetic')
      .select((eb) => [
        'UserCosmetic.data',
        cosmeticRepository.findOneByIdRef(eb.ref('UserCosmetic.cosmeticId')).as('cosmetic'),
      ])
      .where(({ eb, and }) =>
        and([eb('equippedAt', 'is not', null), eb('equippedToId', 'is', null)])
      );
  }

  private get privateUserCosmeticSelect() {
    return this.publicUserCosmeticSelect.select([
      'equippedAt',
      'cosmeticId',
      'obtainedAt',
      'claimKey',
    ]);
  }

  private buildSelect<T extends Views>({ select }: Options<T>) {
    switch (select) {
      case 'public':
        return this.publicUserCosmeticSelect;
      case 'private':
        return this.privateUserCosmeticSelect;
      default:
        throw new Error('not implemented');
    }
  }

  findManyByIdRef(foreignKey: Expression<number>, options: Options = {}) {
    return jsonArrayFrom(
      this.buildSelect(options).whereRef('UserCosmetic.userId', '=', foreignKey)
    );
  }

  async findMany(userIds: number[], options: Options = {}) {
    return await this.buildSelect(options)
      .select(['userId'])
      .where('userId', 'in', userIds)
      .execute();
  }
}

// export const userCosmeticRepository = new UserCosmeticRepository();

export type UserCosmeticModel = InferResult<typeof userCosmeticSelect>;
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

export const userCosmeticRepository = {
  /** returns json array of UserCosmeticModel */
  findManyByUserIdRef(foreignKey: Expression<number>) {
    return jsonArrayFrom(userCosmeticSelect.whereRef('UserCosmetic.userId', '=', foreignKey));
  },
  async findMany(userIds: number[]) {
    return await userCosmeticSelect.select(['userId']).where('userId', 'in', userIds).execute();
  },
};
