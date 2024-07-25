import { Expression, InferResult, sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { UserCosmeticRepository } from '~/server/repository/user-cosmetic.repository';

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
  'postId',
  'createdAt',
  'needsReview',
  sql<boolean>`(
    CASE
      WHEN meta IS NULL OR jsonb_typeof(meta) = 'null' OR "hideMeta" THEN FALSE
      ELSE TRUE
    END
  )`.as('hasMeta'),
  sql<boolean>`(
    CASE
      WHEN meta->>'civitaiResources' IS NOT NULL
      THEN TRUE
      ELSE FALSE
    END
  )`.as('onSite'),
  UserCosmeticRepository.findManyByEntityIdRef({ ref: eb.ref('Image.id'), entity: 'Image' }).as(
    'cosmetics'
  ),
]);

// or([eb('meta', 'is', null), eb('meta', 'is', null)])

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
