import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildDatasetZip, runZipTrigger, uniqueBaseNames } from './dataset-zip';
import { suggestTrigger } from '../routes/triggerSuggest';

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

  it('leads each caption with the trigger word so re-importing the zip restores it', async () => {
    const load = async () => new Blob(['x']);
    const { blob } = await buildDatasetZip(
      [
        { base: 'a', ext: 'png', caption: 'smile, hat', load },
        { base: 'b', ext: 'png', caption: 'outdoors, MyChar', load },
        { base: 'c', ext: 'png', caption: 'dress', load },
        { base: 'd', ext: 'png', caption: '', load },
      ],
      'mychar'
    );
    const zip = await JSZip.loadAsync(await blob!.arrayBuffer());
    const captions = await Promise.all(
      ['a', 'b', 'c'].map((b) => zip.file(`${b}.txt`)!.async('string'))
    );
    // Already present: left where it is. Uncaptioned: still no .txt, so the import auto-labels it.
    expect(captions).toEqual(['mychar, smile, hat', 'outdoors, MyChar', 'mychar, dress']);
    expect(zip.file('d.txt')).toBeNull();
    expect(suggestTrigger([...captions, ''])).toBeNull(); // 2 of 3 lead with it: under 75%
    expect(suggestTrigger([captions[0]!, captions[2]!, ''])).toBe('mychar');
  });

  it('returns no blob when nothing loaded', async () => {
    const result = await buildDatasetZip([
      { base: 'a', caption: 'x', load: () => Promise.reject(new Error('x')) },
    ]);
    expect(result).toEqual({ blob: null, included: 0, failed: 1 });
  });
});

describe('runZipTrigger', () => {
  it("carries an AI Toolkit run's trigger word into its download, and nothing for runs without one", () => {
    expect(runZipTrigger({ triggerWord: 'mychar' })).toBe('mychar');
    expect(runZipTrigger({})).toBe('');
    expect(runZipTrigger({ triggerWord: 42 })).toBe('');
  });
});
