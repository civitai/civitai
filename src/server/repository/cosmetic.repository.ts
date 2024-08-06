import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

export type CosmeticModel = InferResult<(typeof CosmeticRepository)['cosmeticSelect']>;

export class CosmeticRepository {
  private static get cosmeticSelect() {
    return kyselyDbRead
      .selectFrom('Cosmetic')
      .select((eb) => [
        'id',
        'name',
        'description',
        'type',
        'source',
        eb.ref('data').$castTo<any>().as('data'),
        'videoUrl',
      ]);
  }

  static findOneByIdRef(foreignKey: Expression<number>) {
    return jsonObjectFrom(this.cosmeticSelect.whereRef('Cosmetic.id', '=', foreignKey).limit(1));
  }

  static async findOne(id: number) {
    return await this.cosmeticSelect.where('id', '=', id).executeTakeFirst();
  }

  static async findMany(ids: number[]) {
    return await this.cosmeticSelect.where('id', 'in', ids).execute();
  }
}
