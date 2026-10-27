import { describe, expect, it, vi } from 'vitest';
import {
  groupByStart,
  matchZipPairs,
  pairItems,
  pairProblem,
  seedEditPrompts,
  type EditPair,
} from './editPairs';
import type { Img } from './trainingFlow';

// train-core (for trainingBlobKey) loads the SDK, whose dist Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({}));

const img = (over: Partial<Img> = {}): Img => ({
  id: Math.random(),
  name: 'a.png',
  previewUrl: '',
  mediaType: 'image',
  status: 'uploaded',
  progress: 1,
  blobId: 'blob-a',
  blobUrl: 'https://orch.example/v2/consumer/blobs/blob-a.png?sig=1',
  tags: [],
  caption: '',
  ...over,
});

let ids = 0;
const pair = (over: Partial<EditPair> = {}): EditPair => ({
  id: ++ids,
  before: img(),
  after: img({ blobId: 'blob-b' }),
  instruction: 'turn it around',
  source: 'upload',
  ...over,
});

describe('matchZipPairs', () => {
  it("pairs AI-Toolkit's control_1/main layout by name, with the after side's caption", () => {
    const match = matchZipPairs([
      'set/control_1/IMG_2.png',
      'set/control_1/img_10.jpg',
      'set/main/img_2.png',
      'set/main/img_2.txt',
      'set/control_1/img_10.txt',
      'set/main/img_10.jpg',
    ]);
    expect(match).toEqual({
      pairs: [
        {
          base: 'img_2',
          beforePath: 'set/control_1/IMG_2.png',
          afterPath: 'set/main/img_2.png',
          captionPath: 'set/main/img_2.txt',
        },
        {
          base: 'img_10',
          beforePath: 'set/control_1/img_10.jpg',
          afterPath: 'set/main/img_10.jpg',
          captionPath: 'set/control_1/img_10.txt',
        },
      ],
      orphanAfters: [],
      ignored: [],
    });
  });

  it('reports an after image with no start and keeps a start with no after', () => {
    const match = matchZipPairs(['before/tote.png', 'after/IMG_2231.png', 'control_2/logo.png']);
    expect(match?.pairs).toEqual([
      { base: 'tote', beforePath: 'before/tote.png', afterPath: undefined, captionPath: undefined },
    ]);
    expect(match?.orphanAfters).toEqual(['after/IMG_2231.png']);
    expect(match?.ignored).toEqual(['control_2/logo.png']);
  });

  it('is null for a plain dataset zip, so it is not imported as pairs', () => {
    expect(matchZipPairs(['img_1.png', 'img_1.txt'])).toBeNull();
  });
});

describe('pairProblem', () => {
  it('keeps every unfinished pair out of training', () => {
    expect(pairProblem(pair())).toBeNull();
    expect(pairProblem(pair({ after: undefined }))).toBe('no-after');
    expect(pairProblem(pair({ instruction: '   ' }))).toBe('no-instruction');
    expect(pairProblem(pair({ after: img({ status: 'uploading' }) }))).toBe('uploading');
    expect(pairProblem(pair({ before: img({ status: 'blocked' }), after: undefined }))).toBe(
      'failed'
    );
  });
});

describe('groupByStart', () => {
  it('groups identical starting images across sources and keeps the rest in list order', () => {
    const a = pair({ before: img({ hash: 'h1' }) });
    const b = pair({ before: img({ blobId: 'blob-x', hash: undefined }) });
    const c = pair({ before: img({ hash: 'h1' }), source: 'zip' });
    const d = pair({ before: img({ blobId: undefined, hash: undefined, status: 'uploading' }) });
    const { groups, singles } = groupByStart([a, b, c, d]);
    expect(groups).toEqual([{ key: 'sha:h1', pairs: [a, c] }]);
    expect(singles).toEqual([b, d]);
  });
});

describe('pairItems', () => {
  it('places each ready pair under one name in control_1/ and main/, the result captioned', () => {
    const a = pair({
      before: img({ name: 'tee.png', blobId: 'start-a' }),
      after: img({
        name: 'gen_result',
        blobId: 'res-a',
        blobUrl: 'https://o/v2/consumer/blobs/res-a.jpeg?s=1',
      }),
      instruction: ' add a smiley ',
    });
    const b = pair({ before: img({ blobId: 'start-b' }), after: img({ blobId: 'res-b' }) });
    const unfinished = pair({ after: undefined });
    expect(pairItems([a, unfinished, b])).toEqual([
      { air: 'start-a', caption: '', path: 'control_1/pair_0001.png' },
      { air: 'res-a', caption: 'add a smiley', path: 'main/pair_0001.jpeg' },
      { air: 'start-b', caption: '', path: 'control_1/pair_0002.png' },
      { air: 'res-b', caption: 'turn it around', path: 'main/pair_0002.png' },
    ]);
  });
});

describe('seedEditPrompts', () => {
  it('samples ready pairs only, each from its own starting image and instruction', () => {
    const ready = pair({ instruction: 'make it night' });
    const seeded = seedEditPrompts([ready, pair({ after: undefined }), pair({ instruction: '' })]);
    expect(seeded).toEqual([
      { id: 0, text: 'make it night', image: { url: ready.before.blobUrl, name: 'a.png' } },
    ]);
  });
});
