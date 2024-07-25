import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, kyselyDbRead } from '~/server/kysely-db';

export type UserLinkModel = InferResult<(typeof UserLinkRepository)['userLinkSelect']>;

export class UserLinkRepository {
  // #region [select]
  private static get userLinkSelect() {
    return kyselyDbRead.selectFrom('UserLink').select(['id', 'userId', 'url', 'type']);
  }
  // #endregion

  // #region [helpers]
  static findManyByUserIdRef(foreignKey: Expression<number>) {
    return jsonArrayFrom(this.userLinkSelect.whereRef('UserLink.userId', '=', foreignKey));
  }
  // #endregion

  // #region [main]
  static async findMany(userIds: number[]) {
    return await this.userLinkSelect.where('userId', 'in', userIds).execute();
  }
  // #endregion
}
