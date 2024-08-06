import { Expression, InferResult } from 'kysely';
import { jsonObjectFrom, kyselyDbRead } from '~/server/kysely-db';

export type ImageMetricModel = InferResult<(typeof ImageMetricRepository)['imageMetricSelect']>;

export class ImageMetricRepository {
  // #region [select]
  private static get imageMetricSelect() {
    return kyselyDbRead
      .selectFrom('ImageMetric')
      .select([
        'cryCount as cryCountAllTime',
        'laughCount as laughCountAllTime',
        'likeCount as likeCountAllTime',
        'dislikeCount as dislikeCountAllTime',
        'heartCount as heartCountAllTime',
        'commentCount as commentCountAllTime',
        'collectedCount as collectedCountAllTime',
        'tippedAmountCount as tippedAmountCountAllTime',
        'viewCount as viewCountAllTime',
      ]);
  }
  // #endregion

  // #region [helpers]
  static findOneByImageIdRef(ref: Expression<number>) {
    return jsonObjectFrom(
      this.imageMetricSelect
        .whereRef('ImageMetric.imageId', '=', ref)
        .where('timeframe', '=', 'AllTime')
    );
  }
  // #endregion

  // #region [main]
  // #endregion
}
