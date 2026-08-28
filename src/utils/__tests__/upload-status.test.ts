import { describe, expect, it } from 'vitest';

import { isUploadInFlight, type TrackedFileStatus } from '~/utils/upload-status';

/**
 * The spinner predicate for `useCFImageUpload` tracked files.
 *
 * 🔴 WHY THIS EXISTS AS A TESTED UNIT AT ALL. Four consumers open-coded it as
 * `imageFile && imageFile.progress < 100` and every one was wrong in the same
 * direction — `progress` is written only by the `xhr.upload` progress listener, and
 * neither the success branch nor either failure branch touches it. A PUT refused before
 * its first progress event therefore leaves `progress` at its initial `0`, and
 * `progress < 100` reads that as "still uploading" forever. In two of those four the
 * render is `showLoading ? overlay : previewUrl ? preview : <Dropzone/>`, so a latched
 * spinner unmounts the Dropzone and there is no retry short of a page reload.
 *
 * These are hand-written literals for what each status MEANS, not values recomputed
 * from the implementation. The two components that own the latching render have no
 * executed test of their own — the component project is browser-mode and does not run
 * here — so this predicate is where the defect is actually pinned.
 */
describe('isUploadInFlight', () => {
  const t = (status: TrackedFileStatus) => ({ status });

  it.each<TrackedFileStatus>(['pending', 'uploading'])(
    'is IN FLIGHT for %j — the upload has not settled',
    (status) => {
      expect(isUploadInFlight(t(status))).toBe(true);
    }
  );

  it.each<TrackedFileStatus>(['success', 'error', 'aborted', 'blocked'])(
    'is SETTLED for %j — the spinner must clear',
    (status) => {
      expect(isUploadInFlight(t(status))).toBe(false);
    }
  );

  it('clears on `error` even though `progress` never reached 100', () => {
    // 🔴 THE REGRESSION CASE, spelled out. This is the exact shape a refused presigned
    // PUT leaves behind: the hook marks the tracked file `error` and no progress event
    // ever fired, so `progress` is still 0. The old `progress < 100` spelling returns
    // `true` here — permanently.
    const refusedBeforeAnyProgress = { status: 'error' as const, progress: 0 };
    expect(isUploadInFlight(refusedBeforeAnyProgress)).toBe(false);
  });

  it('is IN FLIGHT while uploading even when `progress` has already reached 100', () => {
    // The mirror-image failure of the same replaced expression, and the reason this
    // suite cannot be satisfied by a predicate that still reads `progress`: the request
    // body can be fully sent (progress 100) while the store has not yet answered, so
    // `progress >= 100` would clear the spinner before the outcome is known.
    const bodySentAwaitingResponse = { status: 'uploading' as const, progress: 100 };
    expect(isUploadInFlight(bodySentAwaitingResponse)).toBe(true);
  });

  it.each([null, undefined])('is SETTLED for %j — nothing has been dropped yet', (value) => {
    expect(isUploadInFlight(value)).toBe(false);
  });
});
