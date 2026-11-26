import { describe, expect, it } from 'vitest';
import { isFeedbackCaptureReady } from '@civitai/shared/feedback-capture';
import { classifyBlockImageUploadScan } from '~/server/services/blocks/block-image-upload.logic';

/**
 * HQ attaches a page capture on `classifyBlockImageUploadScan`'s `ready`; the moderator app shows one
 * unblurred on `isFeedbackCaptureReady`. A capture HQ received must not be one moderators see blurred,
 * or the reverse.
 */
describe('isFeedbackCaptureReady', () => {
  const ingestions = ['Pending', 'Scanned', 'Blocked', 'NotFound', 'Error', 'Rescan'];
  const levels = [0, 1, 2, 4, 8, 16, 32, 3, 5];
  const flags = [null, false, true] as const;
  const reviews = [null, 'poi', 'csam'];

  it('agrees with the HQ attach gate on every combination', () => {
    let checked = 0;
    let ready = 0;
    for (const ingestion of ingestions)
      for (const nsfwLevel of levels)
        for (const needsReview of reviews)
          for (const poi of flags)
            for (const minor of flags)
              for (const tosViolation of flags) {
                const row = { ingestion, nsfwLevel, needsReview, poi, minor, tosViolation };
                const hq = classifyBlockImageUploadScan(row).status === 'ready';
                expect(isFeedbackCaptureReady(row), JSON.stringify(row)).toBe(hq);
                checked++;
                if (hq) ready++;
              }
    // The grid reached both answers, so agreement is not two functions that always say no.
    expect(ready).toBeGreaterThan(0);
    expect(checked - ready).toBeGreaterThan(0);
  });
});
