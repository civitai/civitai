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
 * Three consumers open-coded this as `imageFile && imageFile.progress < 100`, and every
 * one of them was wrong in the same direction — which is what a predicate open-coded at
 * N sites does. `progress` is written by exactly one place, the `xhr.upload` progress
 * listener in `src/hooks/useCFImageUpload.tsx`; neither the success branch nor either
 * failure branch touches it. So:
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
