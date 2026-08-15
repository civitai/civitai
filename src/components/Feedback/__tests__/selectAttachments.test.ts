import { describe, expect, it } from 'vitest';
import { selectAttachments } from '~/components/Feedback/selectAttachments';
import { constants } from '~/server/common/constants';
import { FEEDBACK_IMAGE_MAX_COUNT } from '~/shared/constants/feedback.constants';

/**
 * The two caps on user-chosen attachments: how many, and how big.
 *
 * The size cap is the one that was missing. `SCREENSHOT_MAX_BYTES` bounds the capture
 * this feature GENERATES; nothing bounded the files the user PICKS, so a 40-megapixel
 * phone photo would upload at full size. There is no server backstop — the presigned
 * PUT from `/api/v1/image-upload` carries no size condition — so this function is the
 * only check that exists.
 *
 * Sizes are literals in bytes; nothing here is derived from the implementation.
 */
const MB = 1024 * 1024;
const MAX_BYTES = 50 * MB;

const file = (name: string, bytes: number) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

const run = (selected: File[], alreadyAttached = 0) =>
  selectAttachments({
    selected,
    alreadyAttached,
    maxCount: FEEDBACK_IMAGE_MAX_COUNT,
    maxBytes: MAX_BYTES,
  });

const names = (files: File[]) => files.map((f) => f.name);

describe('the caps themselves', () => {
  it('takes the size cap from the shared upload constant nine other surfaces use', () => {
    // Pinned so the feedback picker cannot quietly diverge from the rest of the app.
    expect(constants.mediaUpload.maxImageFileSize).toBe(50 * 1024 ** 2);
    expect(MAX_BYTES).toBe(constants.mediaUpload.maxImageFileSize);
  });

  it('caps the count at 3', () => {
    expect(FEEDBACK_IMAGE_MAX_COUNT).toBe(3);
  });
});

describe('size cap', () => {
  it('accepts a file one byte under the limit', () => {
    const result = run([file('ok.png', MAX_BYTES - 1)]);
    expect(names(result.accepted)).toEqual(['ok.png']);
    expect(result.rejectedForSize).toEqual([]);
  });

  it('accepts a file exactly at the limit', () => {
    const result = run([file('edge.png', MAX_BYTES)]);
    expect(names(result.accepted)).toEqual(['edge.png']);
    expect(result.rejectedForSize).toEqual([]);
  });

  it('rejects a file one byte over the limit', () => {
    const result = run([file('huge.png', MAX_BYTES + 1)]);
    expect(result.accepted).toEqual([]);
    expect(names(result.rejectedForSize)).toEqual(['huge.png']);
  });

  it('rejects only the oversized files and keeps the rest', () => {
    const result = run([file('a.png', 1 * MB), file('huge.png', 60 * MB), file('b.png', 2 * MB)]);
    expect(names(result.accepted)).toEqual(['a.png', 'b.png']);
    expect(names(result.rejectedForSize)).toEqual(['huge.png']);
    expect(result.rejectedForCount).toEqual([]);
  });

  it('reports every oversized file, not just the first', () => {
    const result = run([file('h1.png', 60 * MB), file('h2.png', 70 * MB)]);
    expect(names(result.rejectedForSize)).toEqual(['h1.png', 'h2.png']);
  });
});

describe('count cap', () => {
  it('accepts exactly 3 from an empty draft', () => {
    const result = run([file('a.png', 1), file('b.png', 1), file('c.png', 1)]);
    expect(names(result.accepted)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(result.rejectedForCount).toEqual([]);
  });

  it('rejects the fourth', () => {
    const result = run([file('a.png', 1), file('b.png', 1), file('c.png', 1), file('d.png', 1)]);
    expect(names(result.accepted)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(names(result.rejectedForCount)).toEqual(['d.png']);
  });

  it('counts what is already attached', () => {
    const result = run([file('b.png', 1), file('c.png', 1), file('d.png', 1)], 2);
    expect(names(result.accepted)).toEqual(['b.png']);
    expect(names(result.rejectedForCount)).toEqual(['c.png', 'd.png']);
  });

  it('accepts nothing when the draft is already full', () => {
    const result = run([file('d.png', 1)], 3);
    expect(result.accepted).toEqual([]);
    expect(names(result.rejectedForCount)).toEqual(['d.png']);
  });

  /**
   * 🔴 The negative-remaining clamp, with the case that actually discriminates.
   *
   * `alreadyAttached` comes from live component state, so `maxCount - alreadyAttached`
   * can go negative. Without `Math.max(0, …)`, `slice(0, negative)` counts from the
   * END of the array and ACCEPTS files.
   *
   * The first draft of this test used `alreadyAttached: 5` with 2 files — remaining
   * -2, and `slice(0, -2)` on a 2-element array is `[]`, so it passed WITH the clamp
   * removed. A mutation run caught that. The discriminating shape is
   * `|remaining| < selected.length`: at remaining -1 with 3 files, the unclamped
   * version accepts the first two.
   */
  it.each([
    ['remaining -1, 3 files (the shape that discriminates)', 4, 3],
    ['remaining -2, 3 files', 5, 3],
    ['remaining -2, 2 files', 5, 2],
  ])('accepts nothing on a negative remaining — %s', (_label, alreadyAttached, count) => {
    const files = Array.from({ length: count }, (_, i) => file(`f${i}.png`, 1));

    const result = run(files, alreadyAttached);

    expect(result.accepted).toEqual([]);
    expect(names(result.rejectedForCount)).toEqual(names(files));
  });
});

describe('the two caps together', () => {
  it('checks size FIRST, so an oversized file does not consume a slot', () => {
    // The whole reason for the ordering. With count applied first, the 60MB file
    // would take a slot and then be discarded, leaving the user with 2 attachments
    // and no explanation.
    const result = run([
      file('huge.png', 60 * MB),
      file('a.png', 1 * MB),
      file('b.png', 1 * MB),
      file('c.png', 1 * MB),
    ]);
    expect(names(result.accepted)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(names(result.rejectedForSize)).toEqual(['huge.png']);
    expect(result.rejectedForCount).toEqual([]);
  });

  it('reports both rejection reasons separately when both apply', () => {
    const result = run([
      file('huge.png', 60 * MB),
      file('a.png', 1),
      file('b.png', 1),
      file('c.png', 1),
      file('d.png', 1),
    ]);
    expect(names(result.accepted)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(names(result.rejectedForSize)).toEqual(['huge.png']);
    expect(names(result.rejectedForCount)).toEqual(['d.png']);
  });

  it('preserves the picked order in accepted', () => {
    const result = run([file('z.png', 1), file('a.png', 1)]);
    expect(names(result.accepted)).toEqual(['z.png', 'a.png']);
  });

  it('returns three empty lists for an empty selection', () => {
    expect(run([])).toEqual({ accepted: [], rejectedForSize: [], rejectedForCount: [] });
  });
});
