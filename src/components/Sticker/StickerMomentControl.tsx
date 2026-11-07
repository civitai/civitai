import { SegmentedControl, Slider, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
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

/** Static, or pinned to where the video is: the playhead sets when the sticker shows. */
export function StickerMomentControl({
  video,
  moment,
  following,
  onChange,
}: {
  video: HTMLVideoElement;
  moment: Moment | undefined;
  /** Whether scrubbing moves this one. Only the selected draft follows the playhead. */
  following: boolean;
  onChange: (moment: Moment | undefined) => void;
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
    const follow = () => onChange({ startMs: playheadMs(video), durationMs: windowMs });
    video.addEventListener('seeked', follow);
    video.addEventListener('timeupdate', follow);
    return () => {
      video.removeEventListener('seeked', follow);
      video.removeEventListener('timeupdate', follow);
    };
    // `onChange` is a new closure every render and only writes to the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, pinned, following, windowMs]);

  return (
    <div
      className="flex flex-col items-center gap-1 rounded-lg bg-black/80 p-1.5"
      style={{ width: WIDTH }}
    >
      <SegmentedControl
        size="xs"
        radius="xl"
        fullWidth
        value={moment ? 'moment' : 'static'}
        onChange={(value) => {
          if (value === 'static') return onChange(undefined);
          // Held on the frame it was pinned to, so the sticker can be lined up with it.
          video.pause();
          onChange({
            startMs: playheadMs(video),
            durationMs: STICKER_MOMENT_DEFAULT_DURATION_MS,
          });
        }}
        data={[
          { label: 'Static', value: 'static' },
          { label: 'Pin to a moment', value: 'moment' },
        ]}
      />

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
                max={durationMs}
                step={100}
                value={Math.min(moment.startMs, durationMs)}
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
            onChange={(value) => onChange({ ...moment, durationMs: Number(value) })}
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
