import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

const userRankSelect = kyselyDbRead
  .selectFrom('UserRank')
  .select(['leaderboardRank', 'leaderboardId', 'leaderboardTitle', 'leaderboardCosmetic']);

export type UserRankModel = InferResult<typeof userRankSelect>;

export const userRankRepository = {
  findOneByUserIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(userRankSelect.where('UserRank.userId', '=', foreignKey));
  },
};
