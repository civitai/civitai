import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

export type UserRankModel = InferResult<(typeof UserRankRepository)['userRankSelect']>;

export class UserRankRepository {
  // #region [select]
  private static get userRankSelect() {
    return kyselyDbRead
      .selectFrom('UserRank')
      .select(['leaderboardRank', 'leaderboardId', 'leaderboardTitle', 'leaderboardCosmetic']);
  }
  // #endregion

  // #region [helpers]
  static findOneByUserIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.userRankSelect.where('UserRank.userId', '=', foreignKey));
  }
  // #endregion

  // #region [main]

  // #endregion
}
