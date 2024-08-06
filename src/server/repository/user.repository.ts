import { SqlBool, Expression, InferResult, sql } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { ImageRepository } from '~/server/repository/image.repository';
import { UserCosmeticRepository } from '~/server/repository/user-cosmetic.repository';
import { UserLinkRepository } from '~/server/repository/user-link.repository';
import { UserRankRepository } from '~/server/repository/user-rank.repository';
import { UserStatRepository } from '~/server/repository/user-stats.repository';
import { ModelRepository } from '~/server/repository/model.repository';

export type UserBaseModel = InferResult<(typeof UserRepository)['baseUserSelect']>;
export type UserWithCosmeticModel = InferResult<(typeof UserRepository)['cosmeticUserSelect']>;
export type UserCreatorModel = InferResult<(typeof UserRepository)['creatorUserSelect']>;

export class UserRepository {
  // #region [select]
  private static get baseUserSelect() {
    return kyselyDbRead
      .selectFrom('User')
      .select(['id', 'username', 'deletedAt', 'muted', 'bannedAt', 'createdAt']);
  }

  private static get cosmeticUserSelect() {
    return this.baseUserSelect.select((eb) => [
      'leaderboardShowcase',
      'image',
      ImageRepository.findOneBaseImageByIdRef(eb.ref('User.profilePictureId')).as('profilePicture'),
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

  static async findMany(args: { ids?: number[]; limit: number }) {
    let query = this.cosmeticUserSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('User.id', 'in', args.ids);

    return await query.execute();
  }
  // #endregion
}
