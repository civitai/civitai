/**
 * Review-preview lifecycle of a PENDING publish request, shared by the server (which stores it in
 * the request's `deploy_state`) and the moderator review UI (which renders it). The `preview-`
 * prefix keeps these apart from the production deploy states the same column carries once a
 * request is approved.
 */

/** Values stored in `deploy_state` while a pending request has a review preview. */
export const STORED_REVIEW_PREVIEW_STATES = [
  // Waiting for one of the platform-wide build slots (an automatic start at submit).
  'preview-queued',
  'preview-building',
  'preview-deploying',
  'preview-live',
  'preview-failed',
] as const;
export type StoredReviewPreviewState = (typeof STORED_REVIEW_PREVIEW_STATES)[number];

/**
 * What `getReviewStatus` reports. `preview-expired` is never stored: it is reported for a preview
 * older than {@link REVIEW_PREVIEW_MAX_AGE_MS}, whose resources the cluster janitor reaps at that
 * age. The moderator rebuilds it to review again.
 */
export type ReviewPreviewState = StoredReviewPreviewState | 'preview-expired';

/** A review preview's hard maximum lifetime. Matches the cluster janitor's reap age. */
export const REVIEW_PREVIEW_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** States in which a build slot is held. */
export const BUILDING_REVIEW_PREVIEW_STATES = [
  'preview-building',
  'preview-deploying',
] as const satisfies readonly StoredReviewPreviewState[];

export function isReviewPreviewBuilding(state: string | null | undefined): boolean {
  return (BUILDING_REVIEW_PREVIEW_STATES as readonly string[]).includes(state ?? '');
}
