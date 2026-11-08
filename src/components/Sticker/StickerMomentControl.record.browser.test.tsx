import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { StickerRecording } from '~/components/Sticker/sticker-recording';
import { StickerMomentControl } from '~/components/Sticker/StickerMomentControl';
import type { StickerTrackSample } from '~/shared/utils/sticker-track';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const at = (x: number): StickerTrackSample => ({ x, y: 0.5, scale: 0.2, rotation: 0 });

/** A real element with a clock the test moves, and video frames it presents by hand. */
const fakeVideo = (seconds = 0) => {
  const video = document.createElement('video');
  let time = seconds;
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  Object.defineProperty(video, 'duration', { get: () => 30 });
  video.play = vi.fn(() => Promise.resolve());
  video.pause = vi.fn();
  let pending: VideoFrameRequestCallback[] = [];
  video.requestVideoFrameCallback = (callback) => pending.push(callback);
  video.cancelVideoFrameCallback = () => {
    pending = [];
  };
  return {
    video,
    /** Moves the clock and presents a frame there. */
    frameAt: (next: number) => {
      time = next;
      const due = pending;
      pending = [];
      due.forEach((callback) => callback(0, {} as VideoFrameCallbackMetadata));
    },
  };
};

function Harness({
  video,
  initial,
  held,
  onRecording,
  onPose,
  onCapturing,
}: {
  video: HTMLVideoElement;
  initial: StickerRecording;
  held: { pose: StickerTrackSample };
  onRecording: (recording: StickerRecording | undefined) => void;
  onPose: (pose: StickerTrackSample) => void;
  onCapturing: (capturing: boolean) => void;
}) {
  const [recording, setRecording] = useState<StickerRecording | undefined>(initial);
  return (
    <StickerMomentControl
      video={video}
      moment={undefined}
      following
      onChange={() => undefined}
      recorder={{
        recording,
        onRecordingChange: (next) => {
          setRecording(next);
          onRecording(next);
        },
        pose: () => held.pose,
        onPose,
        onCapturing,
      }}
    />
  );
}

const render = (initial: StickerRecording, seconds = 0) => {
  const fake = fakeVideo(seconds);
  const held = { pose: at(0.1) };
  const onRecording = vi.fn();
  const onPose = vi.fn();
  const onCapturing = vi.fn();
  renderWithProviders(
    <Harness
      video={fake.video}
      initial={initial}
      held={held}
      onRecording={onRecording}
      onPose={onPose}
      onCapturing={onCapturing}
    />
  );
  return { ...fake, held, onRecording, onPose, onCapturing };
};

const recordingStarted = () =>
  expect.element(page.getByText(/^Recording/), { timeout: 8000 }).toBeInTheDocument();

describe('recording a draft’s movement', () => {
  test('captures the pose held at every tick while the video plays, and pausing keeps it', async () => {
    const { video, frameAt, held, onRecording } = render([]);

    await page.getByRole('button', { name: 'Record' }).click();
    await recordingStarted();
    expect(video.play).toHaveBeenCalled();

    held.pose = at(0.3);
    frameAt(0.25);
    held.pose = at(0.6);
    frameAt(0.5);
    await page.getByRole('button', { name: 'Pause' }).click();

    expect(video.pause).toHaveBeenCalled();
    expect(onRecording).toHaveBeenLastCalledWith([
      at(0.1),
      at(0.3),
      at(0.3),
      at(0.6),
      at(0.6),
      at(0.6),
    ]);
  });

  test('re-recording from the playhead keeps the path before it and replaces the rest', async () => {
    const recorded = [at(0.1), at(0.2), at(0.3), at(0.4), at(0.5), at(0.6)];
    const { video, frameAt, held, onRecording } = render(recorded, 0.2);
    held.pose = at(0.9);

    await page.getByRole('button', { name: 'Re-record from here' }).click();
    await recordingStarted();
    frameAt(0.3);
    await page.getByRole('button', { name: 'Stop' }).click();

    expect(onRecording).toHaveBeenLastCalledWith([at(0.1), at(0.2), at(0.9), at(0.9)]);
    expect(video.currentTime).toBe(0);
  });

  test('a seek back during a take ends it, so a looping video cannot record over its start', async () => {
    const { frameAt, held, onRecording } = render([]);

    await page.getByRole('button', { name: 'Record' }).click();
    await recordingStarted();
    held.pose = at(0.5);
    frameAt(0.2);
    held.pose = at(0.9);
    frameAt(0);

    await expect.element(page.getByRole('button', { name: 'Re-record from here' })).toBeVisible();
    expect(onRecording).toHaveBeenLastCalledWith([at(0.1), at(0.5), at(0.5)]);
  });

  test('leaving the mode mid-take drops the take and stops the video', async () => {
    const { video, frameAt, held, onRecording } = render([]);

    await page.getByRole('button', { name: 'Record' }).click();
    await recordingStarted();
    held.pose = at(0.5);
    frameAt(0.3);
    await page.getByText('Static', { exact: true }).click();

    await expect.element(page.getByText(/^Recording/)).not.toBeInTheDocument();
    expect(onRecording).toHaveBeenLastCalledWith(undefined);
    expect(video.pause).toHaveBeenCalledTimes(2);
  });

  test('says when a take is running, so the draft can hold back its Place button', async () => {
    const { onCapturing } = render([]);

    await page.getByRole('button', { name: 'Record' }).click();
    expect(onCapturing).toHaveBeenLastCalledWith(true);
    await recordingStarted();
    await page.getByRole('button', { name: 'Pause' }).click();

    expect(onCapturing).toHaveBeenLastCalledWith(false);
  });

  test('between takes the draft follows its recording as the video seeks', async () => {
    const recorded = [at(0.1), at(0.2), at(0.3), at(0.4)];
    const { video, onPose } = render(recorded);
    await expect.element(page.getByRole('button', { name: 'Re-record from here' })).toBeVisible();

    video.currentTime = 0.25;
    video.dispatchEvent(new Event('seeked'));

    expect(onPose).toHaveBeenLastCalledWith(at(0.3));
  });
});
