import { Expression } from 'kysely';
import { jsonArrayFrom } from '~/server/kysely-db';
import { Repository } from '~/server/repository/infrastructure/repository';

class UserLinkRepository extends Repository {
  private get selectLinks() {
    return this.dbRead.selectFrom('UserLink').select(['id', 'userId', 'url', 'type']);
  }

  findManyByIdRef(foreignKey: Expression<number>) {
    return jsonArrayFrom(this.selectLinks.whereRef('UserLink.userId', '=', foreignKey));
  }

  async findMany(userIds: number[]) {
    return await this.selectLinks.where('userId', 'in', userIds).execute();
  }
}

export const userLinkRepository = new UserLinkRepository();
