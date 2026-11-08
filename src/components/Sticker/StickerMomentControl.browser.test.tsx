import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { clampMomentStart, StickerMomentControl } from '~/components/Sticker/StickerMomentControl';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/** A real element, with the playback state a file with no source cannot have. */
const fakeVideo = (currentTime: number, duration = 30) => {
  const video = document.createElement('video');
  let time = currentTime;
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  Object.defineProperty(video, 'duration', { get: () => duration });
  // Paused unless a test says otherwise: a video with no source reports paused anyway.
  video.pause = vi.fn();
  return video;
};

describe('pinning a draft to a moment of the video', () => {
  test('pinning holds the video on its frame and starts there, for a second', async () => {
    const video = fakeVideo(12.34);
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl video={video} moment={undefined} following onChange={onChange} />
    );

    await page.getByText('Moment', { exact: true }).click();

    expect(video.pause).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ startMs: 12340, durationMs: 1000 });
  });

  test('scrubbing moves the start of the selected draft', async () => {
    const video = fakeVideo(12);
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={video}
        moment={{ startMs: 12000, durationMs: 2000 }}
        following
        onChange={onChange}
      />
    );

    await expect.element(page.getByText('Static')).toBeInTheDocument();
    video.currentTime = 20;
    video.dispatchEvent(new Event('seeked'));

    expect(onChange).toHaveBeenCalledWith({ startMs: 20000, durationMs: 2000 });
  });

  test('a seek on a playing video moves no pin, because looping and resuming are seeks too', async () => {
    const video = fakeVideo(12);
    Object.defineProperty(video, 'paused', { get: () => false });
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={video}
        moment={{ startMs: 12000, durationMs: 2000 }}
        following
        onChange={onChange}
      />
    );

    await expect.element(page.getByText('Static')).toBeInTheDocument();
    video.currentTime = 0;
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('timeupdate'));

    expect(onChange).not.toHaveBeenCalled();
  });

  test('pinning near the end starts early enough to fit the window', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={fakeVideo(29.9)}
        moment={undefined}
        following
        onChange={onChange}
      />
    );

    await page.getByText('Moment', { exact: true }).click();

    expect(onChange).toHaveBeenCalledWith({ startMs: 29000, durationMs: 1000 });
  });

  test('a longer window pulls the start back to fit', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={fakeVideo(29)}
        moment={{ startMs: 29000, durationMs: 1000 }}
        following
        onChange={onChange}
      />
    );

    await page.getByText('3s').click();

    expect(onChange).toHaveBeenCalledWith({ startMs: 27000, durationMs: 3000 });
  });

  test('a window longer than the video starts at the beginning', () => {
    expect(clampMomentStart(1500, 3000, 2000)).toBe(0);
  });

  test('scrubbing leaves a draft that is not selected where it was pinned', async () => {
    const video = fakeVideo(12);
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={video}
        moment={{ startMs: 12000, durationMs: 2000 }}
        following={false}
        onChange={onChange}
      />
    );

    await expect.element(page.getByText('Static')).toBeInTheDocument();
    video.currentTime = 20;
    video.dispatchEvent(new Event('seeked'));

    expect(onChange).not.toHaveBeenCalled();
  });

  test('going back to static clears the moment', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={fakeVideo(12)}
        moment={{ startMs: 12000, durationMs: 2000 }}
        following
        onChange={onChange}
      />
    );

    await page.getByText('Static').click();

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test('the duration chip keeps the start', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <StickerMomentControl
        video={fakeVideo(12)}
        moment={{ startMs: 12000, durationMs: 1000 }}
        following
        onChange={onChange}
      />
    );

    await page.getByText('3s').click();

    expect(onChange).toHaveBeenCalledWith({ startMs: 12000, durationMs: 3000 });
  });
});
