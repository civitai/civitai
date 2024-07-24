import { SqlBool, Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { ImageRepository } from '~/server/repository/image.repository';
import { UserCosmeticRepository } from '~/server/repository/user-cosmetic.repository';
import { UserLinkRepository } from '~/server/repository/user-link.repository';
import { UserRankRepository } from '~/server/repository/user-rank.repository';
import { UserStatRepository } from '~/server/repository/user-stats.repository';
import { ModelRepository } from '~/server/repository/model.repository';

const baseUserSelect = kyselyDbRead
  .selectFrom('User')
  .select(['id', 'username', 'deletedAt', 'muted', 'bannedAt', 'createdAt']);

const cosmeticUserSelect = baseUserSelect.select((eb) => [
  'leaderboardShowcase',
  'image',
  ImageRepository.findOneBaseImageByIdRef(eb.ref('User.profilePictureId')).as('profilePicture'),
  UserCosmeticRepository.findManyByUserIdRef(eb.ref('User.id')).as('cosmetics'),
]);

const creatorUserSelect = cosmeticUserSelect.select((eb) => [
  'publicSettings',
  UserLinkRepository.findManyByUserIdRef(eb.ref('User.id')).as('links'),
  UserRankRepository.findOneByUserIdRef(eb.ref('User.id')).as('rank'),
  UserStatRepository.findOneByUserIdRef(eb.ref('User.id')).as('stats'),
  ModelRepository.getCountByUserIdRef(eb.ref('User.id')).as('modelCount'),
]);

export type UserBaseModel = InferResult<typeof baseUserSelect>;
export type UserCosmeticModel = InferResult<typeof cosmeticUserSelect>;
export type UserCreatorModel = InferResult<typeof creatorUserSelect>;

export class UserRepository {
  static findManyByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(baseUserSelect.whereRef('User.id', '=', foreignKey));
  }

  static async findOneUserCreator(
    args: { id?: number; username?: never } | { id?: never; username?: string }
  ) {
    return await creatorUserSelect
      .where(({ eb, and }) => {
        const ands: Expression<SqlBool>[] = [];
        if (args.id) ands.push(eb('User.id', '=', args.id));
        if (args.username) ands.push(eb('User.username', '=', args.username));
        return and([...ands, eb('User.deletedAt', 'is', null)]);
      })
      .executeTakeFirst();
  }

  static async findMany(args: { ids?: number[]; limit: number }) {
    let query = cosmeticUserSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('User.id', 'in', args.ids);

    return await query.execute();
  }
}
