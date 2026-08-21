/**
 * Paths into the standalone moderator app (`apps/moderator`).
 *
 * Shared because both sides build them and had already drifted: the main app carried four builders in
 * `src/shared/constants/moderator-app.ts` and the moderator app four more in `$lib/entity-url.ts`, each
 * with a comment telling the reader to keep them in step — which is the tell. They did not stay in
 * step: only the moderator app's user-lookup builder took a `section`.
 *
 * These are PATHS, not URLs. The base differs by caller — the main app has `MODERATOR_APP_URL` on the
 * server and `NEXT_PUBLIC_MODERATOR_APP_URL` in the browser, and the moderator app is already on it — so
 * the caller supplies the base, or none for a same-app link.
 *
 * 🔴 `/retool/` is a TRANSITIONAL namespace. That is precisely why these live in one module: when those
 * routes move, the copy that does not get updated is the one that becomes a dead link, and the main app
 * cannot see the moderator app's routes to notice.
 */

const q = (value: string | number) => encodeURIComponent(String(value));

/** `section` is a slug from the app's `user-lookup/sections.ts` (`reports`, `notes`, …). Without one the
 *  bare route redirects to the default section, so a link that means "their reports" has to say so. */
export const moderatorUserLookupPath = (idOrUsername: string | number, section?: string) =>
  section ? `/retool/user-lookup/${section}?q=${q(idOrUsername)}` : `/retool/user-lookup?q=${q(idOrUsername)}`;

export const moderatorImageLookupPath = (imageId: number) => `/retool/image-lookup?q=${q(imageId)}`;

export const moderatorArticleLookupPath = (articleId: number) =>
  `/retool/article-lookup?q=${q(articleId)}`;

export type BulkImageManagerSource =
  | 'post'
  | 'model'
  | 'modelVersion'
  | 'collection'
  | 'user'
  | 'userRemoved'
  | 'imageIds';

/** Bulk Image Manager takes the entity it lists images for as `source` + `q`, never a per-entity param. */
export const moderatorBulkImageManagerPath = (
  source: BulkImageManagerSource,
  idOrUsername: string | number
) => `/retool/bulk-image-manager?source=${source}&q=${q(idOrUsername)}`;
