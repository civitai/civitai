import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom } from '~/server/kysely-db';
import { cosmeticRepository } from '~/server/repository/cosmetic.repository';
import { Repository } from '~/server/repository/infrastructure/repository';

type Options = { select?: 'public' | 'private' };

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

  private buildSelect({ select = 'public' }: Options) {
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

export const userCosmeticRepository = new UserCosmeticRepository();

export type UserCosmeticPublicModel = InferResult<
  UserCosmeticRepository['publicUserCosmeticSelect']
>[number];
export type UserCosmeticPrivateModel = InferResult<
  UserCosmeticRepository['privateUserCosmeticSelect']
>[number];
