import { sql, type RawBuilder } from '@civitai/db/kysely';

/** True in SQL when the image whose id is `imageId` is attached to a service review. */
export const isReviewImageSql = (imageId: RawBuilder<unknown>) =>
  sql<boolean>`EXISTS (SELECT 1 FROM "ServiceDealReviewImage" ri WHERE ri."imageId" = ${imageId})`;
