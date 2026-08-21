/**
 * Paths into the standalone moderator app (`apps/moderator`).
 *
 * The base URL differs by side — `MODERATOR_APP_URL` on the server, `NEXT_PUBLIC_MODERATOR_APP_URL` in
 * the browser — so these are paths, and the caller supplies the base. Keeping the paths here means a
 * link that moves in the spoke is one edit rather than a hunt through components.
 *
 * `/retool/` is a transitional namespace in the spoke, which is exactly why it belongs in one place.
 */
export const moderatorUserLookupPath = (idOrUsername: string | number) =>
  `/retool/user-lookup?q=${encodeURIComponent(String(idOrUsername))}`;

export const moderatorImageLookupPath = (imageId: number) =>
  `/retool/image-lookup?q=${encodeURIComponent(String(imageId))}`;

export const moderatorArticleLookupPath = (articleId: number) =>
  `/retool/article-lookup?q=${encodeURIComponent(String(articleId))}`;

/**
 * Bulk Image Manager takes the entity it lists images for as `source` + `q`, not a per-entity param.
 */
export const moderatorBulkImageManagerPath = (
  source: 'post' | 'model' | 'modelVersion' | 'collection' | 'user',
  idOrUsername: string | number
) => `/retool/bulk-image-manager?source=${source}&q=${encodeURIComponent(String(idOrUsername))}`;
