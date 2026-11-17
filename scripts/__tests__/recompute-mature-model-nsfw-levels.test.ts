import { describe, expect, it } from 'vitest';
import { chunksFrom, outOfScope, parseIdsCsv } from '../recompute-mature-model-nsfw-levels';

/** `outOfScope` is the only gate on which rows `--apply` writes. */

const row = (id: number, over: Partial<Parameters<typeof outOfScope>[1][number]> = {}) => ({
  id,
  nsfw: true,
  deleted: false,
  hasComFace: false,
  hasPublishedVersion: true,
  ...over,
});

describe('recompute-mature-model-nsfw-levels scope', () => {
  it('refuses every id it may not write, and only those', () => {
    const rows = [
      row(1),
      row(2, { hasComFace: true }),
      row(3, { hasPublishedVersion: false }),
      row(4, { nsfw: false }),
      row(5, { deleted: true }),
    ];

    expect(outOfScope([1, 2, 3, 4, 5, 6], rows)).toEqual([
      { id: 2, reason: 'has a civitai.com version' },
      { id: 3, reason: 'no Published version' },
      { id: 4, reason: 'not mature (nsfw = false)' },
      { id: 5, reason: 'deleted' },
      { id: 6, reason: 'not found' },
    ]);
  });

  it('reads the first column of a CSV, skipping the header and blank lines', () => {
    expect(parseIdsCsv('id,nsfwLevel\n12,7\n\n"34",1\n12,7\n')).toEqual([12, 34]);
  });

  it('stops on a value that is not an id', () => {
    expect(() => parseIdsCsv('id\n12\nabc\n')).toThrow('Not a model id');
  });
});

describe('recompute-mature-model-nsfw-levels chunks', () => {
  it('chunks ids in ascending order from the resume id', () => {
    expect(chunksFrom([5, 1, 4, 2, 3], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunksFrom([5, 1, 4, 2, 3], 2, 3)).toEqual([[3, 4], [5]]);
  });
});
