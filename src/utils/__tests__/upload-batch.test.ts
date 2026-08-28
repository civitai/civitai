import { describe, expect, it } from 'vitest';
import { batchUploadFailureNotification } from '~/utils/upload-batch';

/**
 * The shared "some files in this drop failed" report, used by BOTH multi-file upload loops
 * in the comics flow (`PanelModal`'s bulk panel drop and `character.tsx`'s reference drop).
 *
 * 🔴 WHAT THESE ARE FOR. The round-2 audit's finding was not a crash — it was that two
 * identically-shaped loops had two different answers to one question, and that the message
 * a user actually saw ("Failed to upload image") named neither the file nor the count. So
 * the assertions here are on the CONTENT of the message, not merely on its existence: a
 * report that omits the count or the filename is exactly the defect, and would pass a test
 * that only checked "a notification was produced".
 */
describe('batchUploadFailureNotification', () => {
  it('returns null when nothing failed — so no caller can raise a "0 of N" toast', () => {
    // The empty check lives here rather than at each call site, which is what makes the
    // spurious-toast case unreachable instead of merely avoided twice.
    expect(batchUploadFailureNotification([], 5)).toBeNull();
    expect(batchUploadFailureNotification([], 0)).toBeNull();
  });

  it('names how many of how many failed', () => {
    const report = batchUploadFailureNotification(
      [{ name: 'b.png', error: new Error('Upload failed (status 403)') }],
      10
    );

    // Literal, not recomputed from the implementation: both numbers must be present and
    // must be the right way round. "1 of 10" and "10 of 1" are equally well-formed.
    expect(report?.title).toBe('Failed to upload 1 of 10 files');
  });

  it('names EVERY failed file, with its own reason', () => {
    const report = batchUploadFailureNotification(
      [
        { name: 'b.png', error: new Error('Upload failed (status 403)') },
        { name: 'd.png', error: new Error('Upload failed (status 503)') },
      ],
      4
    );

    expect(report?.title).toBe('Failed to upload 2 of 4 files');
    // One entry per failure — `showErrorNotification` renders an array as a list, so a
    // collapsed single string would lose the per-file reason.
    expect(report?.error).toEqual([
      { message: 'b.png: Upload failed (status 403)' },
      { message: 'd.png: Upload failed (status 503)' },
    ]);
  });

  it('says "file" for a single-file drop', () => {
    const report = batchUploadFailureNotification(
      [{ name: 'only.png', error: new Error('nope') }],
      1
    );

    expect(report?.title).toBe('Failed to upload 1 of 1 file');
  });
});
