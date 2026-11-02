// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { shown } from '../held-media-shown';

/**
 * The full view's "on screen" signal: an image whose pixels loaded, or a video 95% played. The
 * element is a stand-in carrying the properties the browser's would.
 */

const element = (props: Record<string, unknown>) => Object.assign(new EventTarget(), props);
const ranges = (spans: [number, number][]) => ({
  length: spans.length,
  start: (i: number) => spans[i][0],
  end: (i: number) => spans[i][1],
});

describe('shown', () => {
  it('fires once an image with pixels has loaded', () => {
    const onshown = vi.fn();
    const img = element({ naturalWidth: 0 });
    shown(img as never, { video: false, onshown });

    img.dispatchEvent(new Event('load'));
    expect(onshown).not.toHaveBeenCalled();
    Object.assign(img, { naturalWidth: 640 });
    img.dispatchEvent(new Event('load'));
    img.dispatchEvent(new Event('load'));

    expect(onshown).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a tenth of a second', 100, [[0, 0.1]]],
    [
      'a seek to the end',
      100,
      [
        [0, 1],
        [99, 100],
      ],
    ],
    ['an unknown duration', NaN, [[0, 100]]],
    ['an endless stream', Infinity, [[0, 100]]],
  ] as [string, number, [number, number][]][])(
    'does not fire for a video after %s',
    (_, duration, spans) => {
      const onshown = vi.fn();
      const video = element({ duration, played: ranges(spans) });
      shown(video as never, { video: true, onshown });
      for (const type of ['loadedmetadata', 'playing', 'timeupdate', 'pause', 'ended'])
        video.dispatchEvent(new Event(type));
      expect(onshown).not.toHaveBeenCalled();
    }
  );

  it('fires once a video has played 95%, across pauses', () => {
    const onshown = vi.fn();
    const video = element({ duration: 100, played: ranges([[0, 50]]) });
    shown(video as never, { video: true, onshown });

    video.dispatchEvent(new Event('pause'));
    expect(onshown).not.toHaveBeenCalled();
    Object.assign(video, {
      played: ranges([
        [0, 50],
        [50, 96],
      ]),
    });
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('ended'));

    expect(onshown).toHaveBeenCalledTimes(1);
  });

  it('a video does not count an image load', () => {
    const onshown = vi.fn();
    const video = element({ naturalWidth: 640, duration: 100, played: ranges([]) });
    shown(video as never, { video: true, onshown });
    video.dispatchEvent(new Event('load'));
    expect(onshown).not.toHaveBeenCalled();
  });

  it.each([
    ['an image', 'img', false, { naturalWidth: 640 }, 'load'],
    ['a video', 'video', true, { duration: 100, played: ranges([[0, 100]]) }, 'ended'],
  ] as const)('hears %s inside the wrapper it sits on', (_, tag, video, props, type) => {
    const onshown = vi.fn();
    const wrapper = document.createElement('div');
    const media = wrapper.appendChild(document.createElement(tag));
    for (const [key, value] of Object.entries(props))
      Object.defineProperty(media, key, { configurable: true, value });
    shown(wrapper, { video, onshown });

    media.dispatchEvent(new Event(type));

    expect(onshown).toHaveBeenCalledTimes(1);
  });

  it('stops listening when destroyed', () => {
    const onshown = vi.fn();
    const img = element({ naturalWidth: 640 });
    shown(img as never, { video: false, onshown }).destroy();
    img.dispatchEvent(new Event('load'));
    expect(onshown).not.toHaveBeenCalled();
  });
});
