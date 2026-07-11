import { useEngagedModelsStore } from '~/store/engaged-models.store';

/**
 * Semantic optimistic mutators for the engaged-models store, one per user
 * action. Each performs the engagement-type bookkeeping that the removed
 * React-Query `user.getEngagedModels.setData(undefined, …)` handlers in
 * `resourceReview.utils.ts` used to do — the store is now the single source for
 * per-visible-set engagement membership (PR4 deleted the legacy endpoint + cache).
 *
 * Notes on the (non-obvious) current semantics these preserve:
 *   - A "favorite"/"like" on the client IS a `Recommended` resource review — the
 *     `Favorite` ModelEngagement enum value is legacy and is NOT written by any
 *     of these actions. (The model page reads `isFavorite` off `Recommended`.)
 *   - Creating / deleting a review, and favoriting, also toggle `Notify`
 *     (auto-watch). Unfavoriting deliberately does NOT clear `Notify`.
 *   - Updating a review touches only `Recommended`.
 *   - Notify/Mute are a single mutually-exclusive server engagement row, so
 *     toggling one clears the other here.
 */

const store = () => useEngagedModelsStore.getState();

/**
 * resourceReview.create — toggles `Recommended` + `Notify` together.
 *
 * F3: the toggle DIRECTION (`shouldRemove`) is derived from `alreadyRecommended`
 * supplied by the caller, which now reads the store's pre-toggle membership via
 * `isModelEngaged(modelId, 'Recommended')`. Accepted cold-read edge: on a
 * directly-loaded model page no feed has warmed membership, so the store reads
 * not-recommended and re-affirming an ALREADY-recommended model adds instead of
 * toggling it off until a feed warms the model's membership.
 */
export function applyReviewCreated(
  modelId: number,
  recommended: boolean,
  alreadyRecommended: boolean
): void {
  const shouldRemove = !recommended || alreadyRecommended;
  store().setMembership(modelId, 'Recommended', !shouldRemove);
  store().setMembership(modelId, 'Notify', !shouldRemove);
}

/**
 * resourceReview.update — toggles `Recommended` only. Direction comes from the
 * caller's `alreadyRecommended` (see `applyReviewCreated`), read from the store's
 * pre-toggle membership; same accepted cold-read edge applies.
 */
export function applyReviewUpdated(
  modelId: number,
  recommended: boolean | null | undefined,
  alreadyRecommended: boolean
): void {
  const shouldRemove = !recommended || alreadyRecommended;
  store().setMembership(modelId, 'Recommended', !shouldRemove);
}

/** resourceReview.delete — removes `Recommended` + `Notify`. */
export function applyReviewDeleted(modelId: number): void {
  store().setMembership(modelId, 'Recommended', false);
  store().setMembership(modelId, 'Notify', false);
}

/** user.toggleFavorite — add `Recommended` + `Notify` when favoriting; remove only `Recommended` when un-favoriting. */
export function applyFavoriteToggled(modelId: number, setTo: boolean): void {
  if (setTo) {
    store().setMembership(modelId, 'Notify', true);
    store().setMembership(modelId, 'Recommended', true);
  } else {
    // Deliberately preserve the current behavior: un-favoriting does not clear Notify.
    store().setMembership(modelId, 'Recommended', false);
  }
}

/** user.toggleNotifyModel — `turnOn` sets Notify (clears Mute); otherwise sets Mute (clears Notify). */
export function applyNotifyToggled(modelId: number, turnOn: boolean): void {
  if (turnOn) {
    store().setMembership(modelId, 'Notify', true);
    store().setMembership(modelId, 'Mute', false);
  } else {
    store().setMembership(modelId, 'Mute', true);
    store().setMembership(modelId, 'Notify', false);
  }
}
