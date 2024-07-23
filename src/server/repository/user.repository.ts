import { SqlBool, Expression } from 'kysely';
import { jsonObjectFrom } from '~/server/kysely-db';
import { Repository } from './infrastructure/repository';
import { imageRepository } from '~/server/repository/image.repository';
import { userCosmeticRepository } from '~/server/repository/user-cosmetic.repository';
import { userLinkRepository } from '~/server/repository/user-link.repository';
import { userRankRepository } from '~/server/repository/user-rank.repository';
import { userStatRepository } from '~/server/repository/user-stats.repository';

type UserIncludes = 'profilePicture' | 'cosmetics' | 'settings';

type Options = { select?: 'emailUser' | 'simpleUser' | 'cosmeticUser' | 'profileUser' };

class UserRepository extends Repository {
  private get simpleUserSelect() {
    return this.dbRead
      .selectFrom('User')
      .select((eb) => [
        'id',
        'username',
        'deletedAt',
        'muted',
        'bannedAt',
        'createdAt',
        'image',
        imageRepository.findByIdRef(eb.ref('User.profilePictureId')).as('profilePicture'),
      ]);
  }

  private get cosmeticUserSelect() {
    return this.simpleUserSelect.select((eb) => [
      'leaderboardShowcase',
      userCosmeticRepository.findManyByIdRef(eb.ref('User.id')).as('cosmetics'),
    ]);
  }

  private get profileUserSelect() {
    return this.simpleUserSelect.select((eb) => [
      userCosmeticRepository
        .findManyByIdRef(eb.ref('User.id'), { select: 'private' })
        .as('cosmetics'),
      userLinkRepository.findManyByIdRef(eb.ref('User.id')).as('links'),
      userRankRepository.findOneByIdRef(eb.ref('User.id')).as('rank'),
      userStatRepository.findOneByIdRef(eb.ref('User.id')).as('stats'),
    ]);
  }

  private buildSelect({ select = 'simpleUser' }: Options) {
    switch (select) {
      case 'simpleUser':
        return this.simpleUserSelect;
      case 'cosmeticUser':
        return this.cosmeticUserSelect;
      case 'profileUser':
        return this.profileUserSelect;
      default:
        throw new Error('not implemented');
    }
  }

  async findOne(id: number, options: Options = {}) {
    const user = await this.buildSelect(options).where('User.id', '=', id).executeTakeFirst();
    return { ...user };
  }

  async findMany(
    {
      ids,
      limit,
    }: {
      ids?: number[];
      limit: number;
    },
    options: Options = {}
  ) {
    let query = this.buildSelect(options).limit(limit);

    if (ids?.length) query = query.where('User.id', 'in', ids);

    return await query.execute();
  }

  async getUserCreator({
    id,
    username,
    include,
  }: {
    id?: number;
    username?: string;
    include?: Array<'links' | 'stats' | 'rank' | 'cosmetics' | 'modelCount'>;
  }) {
    const user = await this.dbRead
      .selectFrom('User')
      .select([
        'id',
        'image',
        'username',
        'muted',
        'bannedAt',
        'deletedAt',
        'createdAt',
        'publicSettings',
        'excludeFromLeaderboards',
      ])
      .where((eb) => {
        const ors: Expression<SqlBool>[] = [];
        if (id) ors.push(eb('User.id', '=', id));
        if (username) ors.push(eb('User.username', '=', username));
        return eb.or(ors);
      })
      .executeTakeFirstOrThrow();

    const linksQuery = this.dbRead
      .selectFrom('UserLink')
      .select(['url', 'type'])
      .where('userId', '=', user.id);

    const statsQuery = this.dbRead
      .selectFrom('UserStat')
      .select([
        'ratingAllTime',
        'ratingCountAllTime',
        'downloadCountAllTime',
        'favoriteCountAllTime',
        'thumbsUpCountAllTime',
        'followerCountAllTime',
        'reactionCountAllTime',
        'uploadCountAllTime',
        'generationCountAllTime',
      ])
      .where('userId', '=', user.id);

    const rankQuery = this.dbRead
      .selectFrom('UserRank')
      .select(['leaderboardRank', 'leaderboardId', 'leaderboardTitle', 'leaderboardCosmetic'])
      .where('userId', '=', user.id);

    const cosmeticsQuery = this.dbRead
      .selectFrom('UserCosmetic')
      .select((eb) => [
        'UserCosmetic.data',
        jsonObjectFrom(
          eb
            .selectFrom('Cosmetic')
            .select(['id', 'name', 'description', 'type', 'source', 'data'])
            .whereRef('UserCosmetic.cosmeticId', '=', 'Cosmetic.id')
        ).as('cosmetic'),
      ])
      .where('UserCosmetic.userId', '=', user.id)
      .where('equippedAt', 'is not', null);

    const modelQuery = this.dbRead
      .selectFrom('Model')
      .select((eb) => [eb.fn.countAll().as('count')])
      .where('userId', '=', user.id)
      .where('status', '=', 'Published');

    const [links, stats, rank, cosmetics, models] = await Promise.all([
      include?.includes('links') ? linksQuery.execute() : undefined,
      include?.includes('stats') ? statsQuery.executeTakeFirst() : undefined,
      include?.includes('rank') ? rankQuery.executeTakeFirst() : undefined,
      include?.includes('cosmetics') ? cosmeticsQuery.execute() : undefined,
      include?.includes('modelCount') ? modelQuery.execute() : undefined,
    ]);

    return {
      ...user,
      links,
      stats,
      rank,
      cosmetics,
      _count: {
        models: models ? Number(models[0].count) : undefined,
      },
    };
  }
}

export const userRepository = new UserRepository();
