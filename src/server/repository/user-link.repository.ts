import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, kyselyDbRead } from '~/server/kysely-db';

const userLinkSelect = kyselyDbRead.selectFrom('UserLink').select(['id', 'userId', 'url', 'type']);

export type UserLinkModel = InferResult<typeof userLinkSelect>;

export class UserLinkRepository {
  static findManyByUserIdRef(foreignKey: Expression<number>) {
    return jsonArrayFrom(userLinkSelect.whereRef('UserLink.userId', '=', foreignKey));
  }

  static async findMany(userIds: number[]) {
    return await userLinkSelect.where('userId', 'in', userIds).execute();
  }
}
