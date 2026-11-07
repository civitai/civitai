import { useEffect, useState } from 'react';
import type { StickerTrack } from '~/shared/utils/sticker-track';
import { sampleStickerTrack } from '~/shared/utils/sticker-track';
import { trpc } from '~/utils/trpc';

const NONE: ReadonlySet<number> = new Set();

export function trackHiddenIdsAt(
  tracks: { id: number; track: StickerTrack }[],
  timeMs: number
): ReadonlySet<number> {
  const hidden = tracks.filter(({ track }) => !sampleStickerTrack(track, timeMs).show);
  return hidden.length ? new Set(hidden.map(({ id }) => id)) : NONE;
}

const sameIds = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * The stickers on this video that its current time hides.
 *
 * Only approved placements have a track here, so a pending one stays on screen for
 * the owner who has to answer it. State changes only when a sticker crosses its
 * window, so playback renders nothing per frame.
 */
export function useTrackHiddenIds(imageId: number, video: HTMLVideoElement | null) {
  const { data: tracks } = trpc.placement.getStickerTracks.useQuery(
    { imageId },
    { enabled: !!video, staleTime: 60_000 }
  );
  const [hiddenIds, setHiddenIds] = useState(NONE);

  useEffect(() => {
    if (!video || !tracks?.length) {
      setHiddenIds(NONE);
      return;
    }
    const rows = tracks as { id: number; track: StickerTrack }[];

    const update = () => {
      const next = trackHiddenIdsAt(rows, video.currentTime * 1000);
      setHiddenIds((current) => (sameIds(current, next) ? current : next));
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

    // A paused video presents no frame to a seek until it lands, and a background tab presents
    // none at all.
    video.addEventListener('seeked', update);
    video.addEventListener('timeupdate', update);
    return () => {
      if (usesVideoFrames) video.cancelVideoFrameCallback(frame);
      else cancelAnimationFrame(frame);
      video.removeEventListener('seeked', update);
      video.removeEventListener('timeupdate', update);
    };
  }, [video, tracks]);

  return hiddenIds;
}
