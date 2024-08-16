import { Expression, InferResult, sql } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';
import { ImageMetricRepository } from '~/server/repository/image-metric.repository';
import { UserCosmeticRepository } from '~/server/repository/user-cosmetic.repository';

export type ImageBaseModel = InferResult<(typeof Image)['baseImageSelect']>;
export type ImageListModel = InferResult<(typeof Image)['feedImageSelect']>;

export class Image {
  // #region [select]
  private static get baseImageSelect() {
    return kyselyDbRead
      .selectFrom('Image')
      .select((eb) => [
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
        eb.ref('metadata').$castTo<any>().as('metadata'),
        'mimeType',
        'createdAt',
        'needsReview',
      ]);
  }

  private static get feedImageSelect() {
    return this.baseImageSelect.select((eb) => [
      'postId',
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
      UserCosmeticRepository.findManyByEntityIdRef({
        ref: eb.ref('Image.id'),
        entity: 'Image',
      }).as('cosmetics'),
      ImageMetricRepository.findOneByImageIdRef(eb.ref('Image.id')).as('stats'),
    ]);
  }
  // #endregion

  // #region [helpers]
  static findOneBaseImageByIdRef(foreignKey: Expression<number | null>) {
    return jsonObjectFrom(this.baseImageSelect.whereRef('Image.id', '=', foreignKey));
  }

  static findOneFeedImageByIdRef(foreignKey: Expression<number | null>) {
    return jsonObjectFrom(this.feedImageSelect.whereRef('Image.id', '=', foreignKey));
  }
  // #endregion

  // #region [main]
  static async findMany(args: { ids?: number[]; limit: number }) {
    let query = this.feedImageSelect.limit(args.limit);

    if (args.ids?.length) query = query.where('Image.id', 'in', args.ids);

    return await query.execute();
  }
  // #endregion
}
