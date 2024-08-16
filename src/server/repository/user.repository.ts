import { SqlBool, Expression, InferResult, sql } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { Image } from '~/server/repository/image.repository';
import { UserCosmeticRepository } from '~/server/repository/user-cosmetic.repository';
import { UserLinkModel, UserLinkRepository } from '~/server/repository/user-link.repository';
import { UserRankRepository } from '~/server/repository/user-rank.repository';
import { UserStatRepository } from '~/server/repository/user-stats.repository';
import { ModelRepository } from '~/server/repository/model.repository';

export type UserBaseModel = InferResult<ReturnType<(typeof UserRepository)['baseUserSelect']>>;
export type UserWithCosmeticModel = InferResult<(typeof UserRepository)['cosmeticUserSelect']>;
export type UserCreatorModel = InferResult<(typeof UserRepository)['creatorUserSelect']>;

/*
  query user ids
  await promise.all([queryUserLinks(userId), queryUserStats(userIds)])
*/

// TODO - base repository class with redis helpers
// export const userRepository = new UserRepository({...redis_config})

export class UserRepository {
  // #region [select]
  private static baseUserSelect(includes: string[] = []) {
    return kyselyDbRead
      .selectFrom('User')
      .select((eb) => ['id', 'username', 'deletedAt', 'muted', 'bannedAt', 'createdAt'])
      .$if(includes.includes('email'), (qb) => qb.select('email'));
  }

  private static get cosmeticUserSelect() {
    return this.baseUserSelect().select((eb) => [
      'leaderboardShowcase',
      'image',
      Image.findOneBaseImageByIdRef(eb.ref('User.profilePictureId')).as('profilePicture'),
      UserCosmeticRepository.findManyByUserIdRef({ ref: eb.ref('User.id'), equipped: true }).as(
        'cosmetics'
      ),
    ]);
  }

  private static get creatorUserSelect() {
    return this.cosmeticUserSelect.select((eb) => [
      eb.ref('publicSettings').$castTo<any>().as('publicSettings'),
      'excludeFromLeaderboards',
      UserLinkRepository.findManyByUserIdRef(eb.ref('User.id')).as('links'),
      UserRankRepository.findOneByUserIdRef(eb.ref('User.id')).as('rank'),
      UserStatRepository.findOneByUserIdRef(eb.ref('User.id')).as('stats'),
      ModelRepository.getCountByUserIdRef(eb.ref('User.id')).as('modelCount'),
    ]);
  }
  // #endregion

  // #region [helpers]
  static findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.cosmeticUserSelect.whereRef('User.id', '=', foreignKey));
  }
  // #endregion

  // #region [main]
  static async findOneUseBasic(args: { id?: number; username?: string }, includes?: 'email'[]) {
    return await this.baseUserSelect(includes)
      .where(({ eb, and }) => {
        const ands: Expression<SqlBool>[] = [];
        if (args.id) ands.push(eb('User.id', '=', args.id));
        if (args.username) ands.push(eb('User.username', '=', args.username));
        return and([...ands, eb('User.deletedAt', 'is', null)]);
      })
      .executeTakeFirst();
  }

  static async findMany(args: { ids?: number[]; limit: number }) {
    let query = this.cosmeticUserSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('User.id', 'in', args.ids);

    return await query.execute();
  }

  static async findOneUserCreator(
    // args: { id?: number; username?: never } | { id?: never; username?: string }
    args: { id?: number; username?: string }
  ) {
    return await this.creatorUserSelect

      .where(({ eb, and }) => {
        const ands: Expression<SqlBool>[] = [];
        if (args.id) ands.push(eb('User.id', '=', args.id));
        if (args.username) ands.push(eb('User.username', '=', args.username));
        return and([...ands, eb('User.deletedAt', 'is', null)]);
      })
      .executeTakeFirst();
  }
  // #endregion
}
