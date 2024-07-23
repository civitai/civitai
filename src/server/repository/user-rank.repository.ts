import { Expression } from 'kysely';
import { jsonObjectFrom } from '~/server/kysely-db';
import { Repository } from '~/server/repository/infrastructure/repository';

class UserRankRepository extends Repository {
  private get userRankSelect() {
    return this.dbRead
      .selectFrom('UserRank')
      .select(['leaderboardRank', 'leaderboardId', 'leaderboardTitle', 'leaderboardCosmetic']);
  }

  findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.userRankSelect.where('UserRank.userId', '=', foreignKey));
  }

  async findOne(userId: number) {
    return await this.userRankSelect.where('userId', '=', userId).executeTakeFirst();
  }
  async findMany(userIds: number[]) {
    return await this.userRankSelect.select(['userId']).where('userId', 'in', userIds).execute();
  }
}

export const userRankRepository = new UserRankRepository();
