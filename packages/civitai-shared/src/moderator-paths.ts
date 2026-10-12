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
  section
    ? `/retool/user-lookup/${section}?q=${q(idOrUsername)}`
    : `/retool/user-lookup?q=${q(idOrUsername)}`;

export const moderatorImageLookupPath = (imageId: number) => `/retool/image-lookup?q=${q(imageId)}`;

export const moderatorArticleLookupPath = (articleId: number) =>
  `/retool/article-lookup?q=${q(articleId)}`;

/** Built as a model URL rather than an extra param: the page resolves `q` the same way whether it came
 *  from here or from a pasted address bar. */
export const moderatorModelLookupPath = (modelId: number, versionId?: number) =>
  `/retool/model-lookup?q=${q(
    versionId ? `/models/${modelId}?modelVersionId=${versionId}` : modelId
  )}`;

/** A version whose model the caller does not know. `mv`, never `q`: a bare number in `q` is a valid
 *  model id AND a valid version id across most of the range, so it resolves model-first and would land
 *  on an unrelated model. The page resolves the version and shows its model with the version pinned. */
export const moderatorModelVersionLookupPath = (versionId: number) =>
  `/retool/model-lookup?mv=${q(versionId)}`;

/** The permanent per-report page, independent of the triage queue's filters and paging. */
export const moderatorFeedbackReportPath = (feedbackId: number) => `/feedback/${q(feedbackId)}`;

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
