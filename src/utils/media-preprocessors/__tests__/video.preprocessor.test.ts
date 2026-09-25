// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/blurhash', () => ({ createBlurHash: () => 'LKO2' }));

import { preprocessVideo } from '~/utils/media-preprocessors/video.preprocessor';

const FIXTURES = join(__dirname, '..', '..', 'metadata', '__tests__', 'fixtures', 'video');

/** A `<video>` stand-in: happy-dom never decodes media, so load and seek events are fired by hand. */
function fakeVideo() {
  const video = {
    videoWidth: 16,
    videoHeight: 16,
    duration: 0.75,
    onloadeddata: null as null | (() => void),
    onloadedmetadata: null as null | (() => void),
    onseeked: null as null | (() => void),
    set src(_: string) {
      queueMicrotask(() => video.onloadeddata?.());
    },
    set currentTime(_: number) {
      queueMicrotask(() => video.onseeked?.());
    },
  };
  return video;
}

describe('preprocessVideo', () => {
  beforeEach(() => {
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'video' ? fakeVideo() : create(tag)) as typeof document.createElement);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the generation meta read from the file', async () => {
    const file = new File([readFileSync(join(FIXTURES, 'core-faststart.mp4'))], 'clip.mp4', {
      type: 'video/mp4',
    });
    const result = await preprocessVideo(file);
    expect(result.metadata).toMatchObject({ width: 16, height: 16 });
    expect(result.meta).toMatchObject({
      prompt: 'a red fox running through snow; cinematic = 35mm # test',
    });
  });

  it('returns no meta for a file without tags', async () => {
    const file = new File([readFileSync(join(FIXTURES, 'plain.mp4'))], 'clip.mp4', {
      type: 'video/mp4',
    });
    expect((await preprocessVideo(file)).meta).toBeUndefined();
  });
});
