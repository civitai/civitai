import { useCallback, useEffect, useRef, useState } from 'react';
import { writeStickerPose } from '~/components/Sticker/sticker-pose-style';
import type { StickerTrack } from '~/shared/utils/sticker-track';
import { sampleStickerTrack, stickerTrackMoves } from '~/shared/utils/sticker-track';
import { trpc } from '~/utils/trpc';

const NONE: ReadonlySet<number> = new Set();

type TrackRow = { id: number; track: StickerTrack };

export function trackHiddenIdsAt(tracks: TrackRow[], timeMs: number): ReadonlySet<number> {
  const hidden = tracks.filter(({ track }) => !sampleStickerTrack(track, timeMs).show);
  return hidden.length ? new Set(hidden.map(({ id }) => id)) : NONE;
}

const sameIds = (a: ReadonlySet<number>, b: ReadonlySet<number>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

/**
 * Plays sticker tracks against this video's time; `bindPose(id)` is the ref that lets a recorded
 * path move a placed sticker. Moving poses are written straight to the elements once per video
 * frame, so playback never renders React.
 */
export function useTrackPlayback(imageId: number, video: HTMLVideoElement | null) {
  const { data: tracks } = trpc.placement.getStickerTracks.useQuery(
    { imageId },
    { enabled: !!video, staleTime: 60_000 }
  );
  const [hiddenIds, setHiddenIds] = useState(NONE);
  const nodes = useRef(new Map<number, HTMLElement>());
  const moving = useRef(new Map<number, StickerTrack>());

  const rows = tracks as TrackRow[] | undefined;
  moving.current = new Map(
    (rows ?? []).filter(({ track }) => stickerTrackMoves(track)).map(({ id, track }) => [id, track])
  );

  const pose = useCallback(
    (id: number, node: HTMLElement) => {
      const track = moving.current.get(id);
      if (track && video)
        writeStickerPose(node, sampleStickerTrack(track, video.currentTime * 1000));
    },
    [video]
  );

  const bindPose = useCallback(
    (id: number) => (node: HTMLElement | null) => {
      if (!node) return void nodes.current.delete(id);
      nodes.current.set(id, node);
      // A paused video presents no frame, so a sticker mounted now would sit at its first pose.
      // A new ref each render on purpose: re-attaching re-poses a sticker whose `data` React rewrote.
      pose(id, node);
    },
    [pose]
  );

  useEffect(() => {
    if (!video || !rows?.length) {
      setHiddenIds(NONE);
      return;
    }

    const update = () => {
      const timeMs = video.currentTime * 1000;
      const next = trackHiddenIdsAt(rows, timeMs);
      setHiddenIds((current) => (sameIds(current, next) ? current : next));
      for (const [id, node] of nodes.current) pose(id, node);
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
  }, [video, rows, pose]);

  return { hiddenIds, bindPose };
}
