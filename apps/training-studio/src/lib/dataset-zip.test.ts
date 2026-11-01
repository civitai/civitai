import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildDatasetZip, uniqueBaseNames } from './dataset-zip';

describe('uniqueBaseNames', () => {
  it('dedupes case-insensitively in input order', () => {
    expect(uniqueBaseNames(['cat', 'Cat', 'cat', 'dog'])).toEqual(['cat', 'Cat-2', 'cat-3', 'dog']);
  });

  it('strips path separators, reserved characters and leading dots, falling back when empty', () => {
    expect(uniqueBaseNames(['../a/b', 'x:y*z', '...', ''])).toEqual([
      '_a_b',
      'x_y_z',
      'image',
      'image-2',
    ]);
  });
});

describe('buildDatasetZip', () => {
  it('pairs each file with a same-named caption, skipping empty captions and failed loads', async () => {
    const { blob, included, failed } = await buildDatasetZip([
      { base: 'a', ext: 'jpg', caption: ' a cat ', load: async () => new Blob(['A']) },
      { base: 'b', caption: '', load: async () => new Blob(['B'], { type: 'image/webp' }) },
      { base: 'c', caption: 'lost', load: () => Promise.reject(new Error('404')) },
    ]);
    expect({ included, failed }).toEqual({ included: 2, failed: 1 });
    const zip = await JSZip.loadAsync(await blob!.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['a.jpg', 'a.txt', 'b.webp']);
    expect(await zip.file('a.txt')!.async('string')).toBe('a cat');
  });

  it('returns no blob when nothing loaded', async () => {
    const result = await buildDatasetZip([
      { base: 'a', caption: 'x', load: () => Promise.reject(new Error('x')) },
    ]);
    expect(result).toEqual({ blob: null, included: 0, failed: 1 });
  });
});
