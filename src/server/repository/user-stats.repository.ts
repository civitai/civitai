import { Expression } from 'kysely';
import { jsonObjectFrom } from '~/server/kysely-db';
import { Repository } from '~/server/repository/infrastructure/repository';

class UserStatRepository extends Repository {
  private get userStatsSelect() {
    return this.dbRead
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
      ]);
  }

  findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.userStatsSelect.whereRef('UserStat.userId', '=', foreignKey));
  }

  async findOne(userId: number) {
    return await this.userStatsSelect.where('userId', '=', userId).executeTakeFirst();
  }
  async findMany(userIds: number[]) {
    return await this.userStatsSelect.select(['userId']).where('userId', 'in', userIds).execute();
  }
}

export const userStatRepository = new UserStatRepository();
