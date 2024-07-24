import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

const baseImageSelect = kyselyDbRead.selectFrom('Image').select((eb) => [
  'id',
  'name',
  'url',
  'nsfwLevel',
  'hash',
  'userId',
  'ingestion',
  'type',
  'width',
  'height',
  // 'metadata',
]);

const listImageSelect = baseImageSelect.select((eb) => [
  'meta', // TODO - select subset
  'postId',
  'scannedAt',
  'createdAt',
  'needsReview',
  'generationProcess',
  // eb.ref('meta', '->')
]);

export type ImageBaseModel = InferResult<typeof baseImageSelect>;
export type ImageListModel = InferResult<typeof listImageSelect>;

export class ImageRepository {
  static findOneBaseImageByIdRef(foreignKey: Expression<number | null>) {
    return jsonObjectFrom(baseImageSelect.whereRef('Image.id', '=', foreignKey));
  }

  static findOneListImageByIdRef(foreignKey: Expression<number | null>) {
    return jsonObjectFrom(listImageSelect.whereRef('Image.id', '=', foreignKey));
  }

  static async findMany(args: { ids?: number[]; limit: number }) {
    let query = listImageSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('Image.id', 'in', args.ids);

    return await query.execute();
  }
}
