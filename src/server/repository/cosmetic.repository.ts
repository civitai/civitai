import { Expression } from 'kysely';
import { jsonObjectFrom } from '~/server/kysely-db';
import { Repository } from '~/server/repository/infrastructure/repository';

class CosmeticRepository extends Repository {
  private get cosmeticSelect() {
    return this.dbRead
      .selectFrom('Cosmetic')
      .select(['id', 'name', 'description', 'type', 'source', 'data', 'videoUrl']);
  }

  private buildQuery() {
    return this.dbRead
      .selectFrom('Cosmetic')
      .select(['id', 'name', 'description', 'type', 'source', 'data', 'videoUrl']);
  }

  findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.cosmeticSelect.whereRef('Cosmetic.id', '=', foreignKey).limit(1));
  }

  async findOne(id: number) {
    return await this.buildQuery().where('id', '=', id).executeTakeFirst();
  }

  async findMany(ids: number[]) {
    return await this.buildQuery().where('id', 'in', ids).execute();
  }
}

export const cosmeticRepository = new CosmeticRepository();
