import { SqlBool, Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { imageRepository } from '~/server/repository/image.repository';
import { userCosmeticRepository } from '~/server/repository/user-cosmetic.repository';
import { userLinkRepository } from '~/server/repository/user-link.repository';
import { userRankRepository } from '~/server/repository/user-rank.repository';
import { userStatRepository } from '~/server/repository/user-stats.repository';
import { modelRepository } from '~/server/repository/model.repository';

const baseUserSelect = kyselyDbRead
  .selectFrom('User')
  .select(['id', 'username', 'deletedAt', 'muted', 'bannedAt', 'createdAt']);

const cosmeticUserSelect = baseUserSelect.select((eb) => [
  'leaderboardShowcase',
  'image',
  imageRepository.findOneBaseImageByIdRef(eb.ref('User.profilePictureId')).as('profilePicture'),
  userCosmeticRepository.findManyByUserIdRef(eb.ref('User.id')).as('cosmetics'),
]);

const creatorUserSelect = cosmeticUserSelect.select((eb) => [
  'publicSettings',
  userLinkRepository.findManyByUserIdRef(eb.ref('User.id')).as('links'),
  userRankRepository.findOneByUserIdRef(eb.ref('User.id')).as('rank'),
  userStatRepository.findOneByUserIdRef(eb.ref('User.id')).as('stats'),
  modelRepository.getCountByUserIdRef(eb.ref('User.id')).as('modelCount'),
]);

export type UserBaseModel = InferResult<typeof baseUserSelect>;
export type UserCosmeticModel = InferResult<typeof cosmeticUserSelect>;
export type UserCreatorModel = InferResult<typeof creatorUserSelect>;

export const userRepository = {
  findManyByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(baseUserSelect.whereRef('User.id', '=', foreignKey));
  },

  async findOneUserCreator(
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
  },

  async findMany(args: { ids?: number[]; limit: number }) {
    let query = cosmeticUserSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('User.id', 'in', args.ids);

    return await query.execute();
  },
};
