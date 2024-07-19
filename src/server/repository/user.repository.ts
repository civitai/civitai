import { SqlBool, Expression } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

export class UserRepository {
  async getUserCreator({
    id,
    username,
    include,
  }: {
    id?: number;
    username?: string;
    include?: Array<'links' | 'stats' | 'rank' | 'cosmetics' | 'modelCount'>;
  }) {
    const user = await kyselyDbRead
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

    const linksQuery = kyselyDbRead
      .selectFrom('UserLink')
      .select(['url', 'type'])
      .where('userId', '=', user.id);

    const statsQuery = kyselyDbRead
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

    const rankQuery = kyselyDbRead
      .selectFrom('UserRank')
      .select(['leaderboardRank', 'leaderboardId', 'leaderboardTitle', 'leaderboardCosmetic'])
      .where('userId', '=', user.id);

    const cosmeticsQuery = kyselyDbRead
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

    const modelQuery = kyselyDbRead
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

type UserCreator = AsyncReturnType<UserRepository['getUserCreator']>;
