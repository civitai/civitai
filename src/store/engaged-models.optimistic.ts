import { isModelEngaged, useEngagedModelsStore } from '~/store/engaged-models.store';

/**
 * Semantic optimistic mutators for the engaged-models store, one per user
 * action. Each mirrors — EXACTLY — the engagement-type bookkeeping the legacy
 * React-Query `user.getEngagedModels.setData(undefined, …)` handlers performed
 * in `resourceReview.utils.ts`, so the migrated (per-visible-set) surfaces stay
 * behaviourally identical to the still-on-old-endpoint feed surfaces.
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

/** resourceReview.create — toggles `Recommended` + `Notify` together. */
export function applyReviewCreated(modelId: number, recommended: boolean): void {
  const shouldRemove = !recommended || isModelEngaged(modelId, 'Recommended');
  store().setMembership(modelId, 'Recommended', !shouldRemove);
  store().setMembership(modelId, 'Notify', !shouldRemove);
}

/** resourceReview.update — toggles `Recommended` only. */
export function applyReviewUpdated(modelId: number, recommended: boolean | null | undefined): void {
  const shouldRemove = !recommended || isModelEngaged(modelId, 'Recommended');
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
