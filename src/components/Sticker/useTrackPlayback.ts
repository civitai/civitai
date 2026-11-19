import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stickerTrackKeyframes } from '~/components/Sticker/sticker-pose-style';
import type { StickerTrack } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  stickerTrackAnimates,
  stickerTrackFrames,
} from '~/shared/utils/sticker-track';
import { trpc } from '~/utils/trpc';

const NONE: ReadonlySet<number> = new Set();

type TrackRow = { id: number; track: StickerTrack };

export function trackHiddenIdsAt(tracks: TrackRow[], timeMs: number): ReadonlySet<number> {
  const hidden = tracks.filter(({ track }) => !sampleStickerTrack(track, timeMs).show);
  return hidden.length ? new Set(hidden.map(({ id }) => id)) : NONE;
}

const sameIds = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

type Ref = (node: HTMLElement | null) => void;

/**
 * Plays sticker tracks against this video's time; `bindPose(id)` is the ref that lets a track
 * move and fade a placed sticker. Each such sticker gets one paused Web Animation of its track,
 * and the video's time is its clock: playback sets one number per sticker per frame and never
 * renders React. A hidden sticker (`hiddenIds`) is hidden outright as well, so it takes no tap.
 */
export function useTrackPlayback(imageId: number, video: HTMLVideoElement | null) {
  const { data: tracks } = trpc.placement.getStickerTracks.useQuery(
    { imageId },
    { enabled: !!video, staleTime: 60_000 }
  );
  const [hiddenIds, setHiddenIds] = useState(NONE);
  const rows = tracks as TrackRow[] | undefined;
  const animations = useRef(new Map<number, Animation>());

  // An Animation refuses a time that is not finite, and a video reports NaN before it has loaded.
  const clock = useCallback(() => {
    const ms = (video?.currentTime ?? 0) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }, [video]);

  const keyframes = useMemo(
    () =>
      new Map(
        (rows ?? [])
          .filter(({ track }) => stickerTrackAnimates(track))
          .map(({ id, track }) => {
            const { duration, frames } = stickerTrackFrames(track);
            return [id, { duration, keyframes: stickerTrackKeyframes(frames) }] as const;
          })
      ),
    [rows]
  );

  // One stable ref per sticker, so a re-render does not rebuild its animation. New tracks make
  // new refs, and React swaps them: the old one cancels, the new one builds.
  const refs = useMemo(() => {
    const byId = new Map<number, Ref>();
    return (id: number): Ref => {
      let ref = byId.get(id);
      if (!ref) {
        ref = (node) => {
          animations.current.get(id)?.cancel();
          animations.current.delete(id);
          const track = keyframes.get(id);
          if (!node || !track) return;
          const animation = node.animate(track.keyframes, {
            duration: track.duration,
            fill: 'both',
          });
          animation.pause();
          // A paused video presents no frame, so a sticker mounted now would sit at its first pose.
          animation.currentTime = clock();
          animations.current.set(id, animation);
        };
        byId.set(id, ref);
      }
      return ref;
    };
  }, [keyframes, clock]);

  useEffect(() => {
    if (!video || !rows?.length) {
      setHiddenIds(NONE);
      return;
    }

    const update = () => {
      const timeMs = clock();
      const next = trackHiddenIdsAt(rows, timeMs);
      setHiddenIds((current) => (sameIds(current, next) ? current : next));
      for (const animation of animations.current.values()) animation.currentTime = timeMs;
    };

    let frame = 0;
    const usesVideoFrames = typeof video.requestVideoFrameCallback === 'function';
    const onFrame = () => {
      update();
      frame = usesVideoFrames
        ? video.requestVideoFrameCallback(onFrame)
        : requestAnimationFrame(onFrame);
    };
    onFrame();

    // The frame loop stalls in a background tab, and a paused seek presents no frame until it lands.
    video.addEventListener('seeked', update);
    video.addEventListener('timeupdate', update);
    return () => {
      if (usesVideoFrames) video.cancelVideoFrameCallback(frame);
      else cancelAnimationFrame(frame);
      video.removeEventListener('seeked', update);
      video.removeEventListener('timeupdate', update);
    };
  }, [video, rows, clock]);

  return { hiddenIds, bindPose: refs };
}
