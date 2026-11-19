// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/blurhash', () => ({ createBlurHash: () => 'LKO2' }));

import { preprocessVideo, SEEK_TIMEOUT_MS } from '~/utils/media-preprocessors/video.preprocessor';

const FIXTURES = join(__dirname, '..', '..', 'metadata', '__tests__', 'fixtures', 'video');

/** A `<video>` stand-in: happy-dom never decodes media, so load and seek events are fired by hand. */
let seekStarted: () => void = () => undefined;

function fakeVideo(seek: 'fires' | 'never' | 'errors' = 'fires') {
  const video = {
    onerror: null as null | (() => void),
    videoWidth: 16,
    videoHeight: 16,
    duration: 0.75,
    onloadeddata: null as null | (() => void),
    onloadedmetadata: null as null | (() => void),
    onseeked: null as null | (() => void),
    removeAttribute: vi.fn(),
    load: vi.fn(),
    set src(_: string) {
      queueMicrotask(() => video.onloadeddata?.());
    },
    set currentTime(_: number) {
      seekStarted();
      if (seek === 'fires') queueMicrotask(() => video.onseeked?.());
      if (seek === 'errors') queueMicrotask(() => video.onerror?.());
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

  it('decodes a large pick two videos at a time', async () => {
    // Five videos started together made the last ones wait on the first in the browser's media
    // pipeline while their load and seek limits ran out, and a video that timed out was dropped.
    let active = 0;
    let maxActive = 0;
    const loads: (() => void)[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'video') return create(tag);
      const video = fakeVideo();
      Object.defineProperty(video, 'src', {
        set: () => {
          maxActive = Math.max(maxActive, ++active);
          loads.push(() => video.onloadeddata?.());
        },
      });
      video.removeAttribute = vi.fn(() => active--);
      return video;
    }) as typeof document.createElement);
    const file = () =>
      new File([readFileSync(join(FIXTURES, 'plain.mp4'))], 'clip.mp4', { type: 'video/mp4' });

    let done = false;
    const all = Promise.all(Array.from({ length: 5 }, () => preprocessVideo(file()))).finally(
      () => (done = true)
    );
    for (let i = 0; i < 100 && !done; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      loads.splice(0).forEach((load) => load());
    }
    expect(await all).toHaveLength(5);
    expect(maxActive).toBe(2);
  });

  it('frees the decoder of a video that fails to load', async () => {
    const video = fakeVideo();
    Object.defineProperty(video, 'src', { set: () => queueMicrotask(() => video.onerror?.()) });
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'video' ? video : create(tag)) as typeof document.createElement);
    const file = new File([readFileSync(join(FIXTURES, 'plain.mp4'))], 'clip.mp4', {
      type: 'video/mp4',
    });
    await expect(preprocessVideo(file)).rejects.toBeDefined();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
  });

  describe('a seek that cannot finish', () => {
    const file = () =>
      new File([readFileSync(join(FIXTURES, 'plain.mp4'))], 'clip.mp4', { type: 'video/mp4' });
    const seeking = (seek: 'never' | 'errors') => {
      const create = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
        tag === 'video' ? fakeVideo(seek) : create(tag)) as typeof document.createElement);
    };

    it('rejects with the poorly-encoded message when seeked never fires, instead of hanging', async () => {
      seeking('never');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        // The seek timer is armed before currentTime is set, so it is pending once the seek starts.
        const started = new Promise<void>((resolve) => (seekStarted = resolve));
        const outcome = expect(preprocessVideo(file())).rejects.toMatch(/poorly encoded/);
        await started;
        await vi.advanceTimersByTimeAsync(SEEK_TIMEOUT_MS + 1);
        await outcome;
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects with the same message when the video errors during the seek', async () => {
      seeking('errors');
      await expect(preprocessVideo(file())).rejects.toMatch(/poorly encoded/);
    });
  });
});
