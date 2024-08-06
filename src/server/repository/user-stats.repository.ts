import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

const userStatsSelect = kyselyDbRead
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

export type UserStatModel = InferResult<typeof userStatsSelect>;

export class UserStatRepository {
  static findOneByUserIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(userStatsSelect.where('UserStat.userId', '=', foreignKey));
  }
}
