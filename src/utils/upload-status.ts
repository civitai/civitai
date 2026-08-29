/**
 * The status a `useCFImageUpload` tracked file can be in.
 *
 * Lives here rather than in the hook so the in-flight predicate below can be imported
 * (and unit-tested) without pulling React and the whole hook module graph in.
 */
export type TrackedFileStatus =
  | 'pending'
  | 'error'
  | 'success'
  | 'uploading'
  | 'aborted'
  | 'blocked';

/**
 * 🔴 "STILL UPLOADING" IS A STATUS, NEVER A PROGRESS NUMBER.
 *
 * 🔴 FIVE consumers open-coded this, every one of them derived from `progress`:
 * `ProfileImageUpload`, `CosmeticShopItemUpsertForm`, `moderator/cosmetic-store/badges`
 * and `useSubmitCreatorShopForm` as `progress < 100`, and `ImageUpload` as
 * `(match && progress < 100) || image.file`. That is what a predicate open-coded at N
 * sites does — three of the five latched outright, the fourth only worked because its
 * `catch` called `resetFiles()` to clear the stuck tracked file, and the fifth needed a
 * second term to compensate.
 *
 * 🔴 FIVE IS THE HISTORICAL COUNT, NOT THE CALL-SITE COUNT — grep finds FOUR callers.
 * `ImageUpload` is the fifth: it got a different remedy (drop the placeholder entry on
 * error, which clears `image.file`), and an `isUploadInFlight(match) ||` added on top of
 * that turned out to be DEAD — `match` is only ever defined when `image.file` is already
 * truthy, so the term could not change the result. It was removed rather than left
 * standing as a claim this rule governs that spinner. See the comment at its `showLoading`.
 *
 * (The other `progress < 100` hits in the repo are progress-BAR colour — "is the bar
 * full" is a legitimate question about `progress`. This one is not.)
 *
 * `progress` is written by exactly one place, the `xhr.upload` progress listener in
 * `src/hooks/useCFImageUpload.tsx`; neither the success branch nor either failure branch
 * touches it. So:
 *
 *   - a PUT refused before any progress event fires (an expired presign answers on the
 *     request headers) leaves `progress` at its initial `0` forever. `progress < 100` is
 *     then permanently true and the spinner never clears;
 *   - a PUT refused after the body is fully sent leaves `progress` at 100, so the
 *     spinner clears and the failure is indistinguishable from a success that produced
 *     no preview.
 *
 * Two opposite wrong answers from the same expression. `status` is the field the hook
 * actually maintains across all four terminal outcomes, so it is the one to ask.
 *
 * `pending` counts as in-flight: the tracked file is pushed with that status BEFORE
 * `xhr.send`, so excluding it would blink the spinner off between the drop and the first
 * progress event.
 */
export function isUploadInFlight(
  trackedFile: { status: TrackedFileStatus } | null | undefined
): boolean {
  if (!trackedFile) return false;
  return trackedFile.status === 'pending' || trackedFile.status === 'uploading';
}
