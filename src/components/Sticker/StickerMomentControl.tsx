import { Button, SegmentedControl, Slider, Switch, Text } from '@mantine/core';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { StickerRecording } from '~/components/Sticker/sticker-recording';
import { RECORDING_TICK_MS } from '~/components/Sticker/sticker-recording';
import { useStickerTrackCapture } from '~/components/Sticker/useStickerTrackCapture';
import type { StickerTrackSample } from '~/shared/utils/sticker-track';
import {
  STICKER_MOMENT_DEFAULT_DURATION_MS,
  STICKER_MOMENT_DURATIONS_MS,
} from '~/shared/utils/sticker-track';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

type Moment = NonNullable<StickerDraft['moment']>;

const WIDTH = 220;

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const playheadMs = (video: HTMLVideoElement) => Math.round(video.currentTime * 1000);

/** Early enough to fit the whole window, because a window past the end never plays out. */
export const clampMomentStart = (startMs: number, windowMs: number, videoMs: number) =>
  videoMs > 0 ? Math.min(startMs, Math.max(0, videoMs - windowMs)) : startMs;

type Recorder = {
  recording: StickerRecording | undefined;
  onRecordingChange: (recording: StickerRecording | undefined) => void;
  /** The draft's pose right now. */
  pose: () => StickerTrackSample;
  /** Moves the draft to a recorded pose. */
  onPose: (pose: StickerTrackSample) => void;
  onCapturing?: (capturing: boolean) => void;
};

/** Static, pinned to a moment set from the playhead, or moving along a recorded path. */
export function StickerMomentControl({
  video,
  moment,
  following,
  onChange,
  recorder,
}: {
  video: HTMLVideoElement;
  moment: Moment | undefined;
  /** Whether scrubbing moves this one. Only the selected draft follows the playhead. */
  following: boolean;
  onChange: (moment: Moment | undefined) => void;
  /** Offers recording movement. */
  recorder?: Recorder;
}) {
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    const read = () =>
      setDurationMs(Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0);
    read();
    video.addEventListener('durationchange', read);
    return () => video.removeEventListener('durationchange', read);
  }, [video]);

  const pinned = !!moment;
  const windowMs = moment?.durationMs;
  useEffect(() => {
    if (!pinned || !following || windowMs == null) return;
    // Paused only: a playing video seeks to the start each time it loops, and the carousel resumes
    // it on the way back to this slide, neither of which is the placer choosing a moment.
    const follow = () => {
      if (!video.paused) return;
      onChange({
        startMs: clampMomentStart(playheadMs(video), windowMs, durationMs),
        durationMs: windowMs,
      });
    };
    video.addEventListener('seeked', follow);
    return () => video.removeEventListener('seeked', follow);
    // `onChange` is a new closure every render and only writes to the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, pinned, following, windowMs, durationMs]);

  return (
    <div
      className="flex flex-col items-center gap-1 rounded-lg bg-black/80 p-1.5"
      style={{ width: WIDTH }}
    >
      <SegmentedControl
        size="xs"
        radius="xl"
        fullWidth
        value={moment ? 'moment' : recorder?.recording ? 'record' : 'static'}
        onChange={(value) => {
          if (value !== 'record') recorder?.onRecordingChange(undefined);
          if (value === 'static') return onChange(undefined);
          video.pause();
          if (value === 'record') {
            onChange(undefined);
            return recorder?.onRecordingChange([]);
          }
          onChange({
            startMs: clampMomentStart(
              playheadMs(video),
              STICKER_MOMENT_DEFAULT_DURATION_MS,
              durationMs
            ),
            durationMs: STICKER_MOMENT_DEFAULT_DURATION_MS,
          });
        }}
        data={[
          { label: 'Static', value: 'static' },
          { label: 'Moment', value: 'moment' },
          ...(recorder ? [{ label: 'Movement', value: 'record' }] : []),
        ]}
      />

      {recorder?.recording && (
        <StickerRecordPanel video={video} {...recorder} recording={recorder.recording} />
      )}

      {moment && (
        <>
          {durationMs > 0 && (
            <div className="w-full px-1">
              <div
                className="relative mb-1 h-1 w-full rounded bg-dark-4"
                data-testid="moment-window"
              >
                <div
                  className="absolute h-1 rounded bg-yellow-5"
                  style={{
                    left: `${Math.min(100, (moment.startMs / durationMs) * 100)}%`,
                    width: `${Math.min(100, (moment.durationMs / durationMs) * 100)}%`,
                  }}
                />
              </div>
              <Slider
                size="xs"
                label={clock}
                aria-label="Moment in the video"
                min={0}
                max={Math.max(0, durationMs - moment.durationMs)}
                step={100}
                value={clampMomentStart(moment.startMs, moment.durationMs, durationMs)}
                onChange={(ms) => {
                  video.currentTime = ms / 1000;
                  onChange({ ...moment, startMs: ms });
                }}
              />
            </div>
          )}
          <Text size="xs" c="white">
            Shows at {clock(moment.startMs)} for
          </Text>
          <SegmentedControl
            size="xs"
            radius="xl"
            fullWidth
            value={String(moment.durationMs)}
            onChange={(value) => {
              const next = Number(value);
              onChange({
                startMs: clampMomentStart(moment.startMs, next, durationMs),
                durationMs: next,
              });
            }}
            data={STICKER_MOMENT_DURATIONS_MS.map((ms) => ({
              label: `${ms / 1000}s`,
              value: String(ms),
            }))}
          />
        </>
      )}
    </div>
  );
}

/** Record, pause and re-record a draft's movement while the video plays. */
function StickerRecordPanel({
  video,
  recording,
  onRecordingChange,
  pose,
  onPose,
  onCapturing,
}: Recorder & { video: HTMLVideoElement; recording: StickerRecording }) {
  const capture = useStickerTrackCapture({
    video,
    recording,
    pose,
    onRecording: onRecordingChange,
    onPose,
    onCapturing,
  });

  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!capture.beat) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 150);
    return () => clearTimeout(timer);
  }, [capture.beat]);

  if (capture.phase === 'countdown')
    return (
      <Text size="xl" fw={700} c="white" aria-live="assertive">
        {capture.count || 'Go'}
      </Text>
    );

  if (capture.phase === 'recording')
    return (
      <div className="flex w-full items-center gap-1.5 px-1">
        <span
          data-testid="recording-beat"
          className={clsx(
            'size-2.5 shrink-0 rounded-full bg-red-6 transition',
            // Reduced motion keeps the beat as a change of brightness, without the pulse.
            flash ? 'opacity-100 motion-safe:scale-150' : 'opacity-50'
          )}
        />
        <Text size="xs" c="white" className="grow">
          Recording {clock(video.currentTime * 1000)}
        </Text>
        <Button size="compact-xs" variant="default" onClick={capture.pause}>
          Pause
        </Button>
        <Button size="compact-xs" color="red" onClick={capture.stop}>
          Stop
        </Button>
      </div>
    );

  return (
    <div className="flex w-full flex-col items-center gap-1 px-1">
      <Text size="xs" c="white">
        {recording.length
          ? `Recorded ${clock(
              recording.length * RECORDING_TICK_MS
            )}. Re-record from any point to change it.`
          : 'Hold the sticker and move it while the video plays.'}
      </Text>
      <Button size="compact-xs" color="red" fullWidth onClick={capture.record}>
        {recording.length ? 'Re-record from here' : 'Record'}
      </Button>
      <Switch
        size="xs"
        label="Tick while recording"
        checked={capture.tickSound}
        onChange={(event) => capture.setTickSound(event.currentTarget.checked)}
        styles={{ label: { color: 'white' } }}
      />
    </div>
  );
}
