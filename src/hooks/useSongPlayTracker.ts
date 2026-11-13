import { useEffect, useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isCountablePlay, songPlayThresholdSec } from '~/shared/utils/song-play';
import { trpc } from '~/utils/trpc';

export type SongPlayTrackerInput = {
  songId: number | null | undefined;
  /** Changes whenever the song starts again from the beginning. */
  playbackId: string | number | null | undefined;
  durationSec: number | null | undefined;
  /** Seconds of audio actually played in this playback. */
  listenedSec: number;
  enabled: boolean;
  /** The song's owner, whose own plays are not reported (the server refuses them anyway). */
  ownerId?: number | null;
};

type PlaybackId = string | number;

const ignore = () => undefined;

/**
 * Reports a playback to the server: a start when it begins, then one complete when the play rule
 * is met. The server decides what counts (`song-play.service`); a lost report is never surfaced.
 *
 * The complete also waits until the rule's time has passed since the start was answered, so the
 * server, which measures from when it recorded the start, has reached it too.
 */
export function useSongPlayTracker({
  songId,
  playbackId,
  durationSec,
  listenedSec,
  enabled,
  ownerId,
}: SongPlayTrackerInput) {
  const currentUser = useCurrentUser();
  const { mutateAsync: sendStart } = trpc.track.songPlayStart.useMutation();
  const { mutateAsync: sendComplete } = trpc.track.songPlay.useMutation();

  const startedFor = useRef<PlaybackId | null>(null);
  const acknowledged = useRef<{ playbackId: PlaybackId; at: number } | null>(null);
  const completedFor = useRef<PlaybackId | null>(null);

  const isOwner = ownerId != null && currentUser?.id === ownerId;
  const active = enabled && !isOwner;

  useEffect(() => {
    if (!active || songId == null || playbackId == null) return;
    if (startedFor.current === playbackId) return;
    startedFor.current = playbackId;
    sendStart({ imageId: songId })
      .then((result) => {
        if (result?.started) acknowledged.current = { playbackId, at: Date.now() };
      })
      .catch(ignore);
  }, [active, playbackId, songId, sendStart]);

  useEffect(() => {
    if (!active || songId == null || playbackId == null) return;
    if (completedFor.current === playbackId) return;
    if (!isCountablePlay(listenedSec, durationSec)) return;

    const complete = () => {
      const ack = acknowledged.current;
      if (!ack || ack.playbackId !== playbackId || completedFor.current === playbackId)
        return false;
      const waitMs = ack.at + songPlayThresholdSec(durationSec) * 1000 - Date.now();
      if (waitMs > 0) return waitMs;
      completedFor.current = playbackId;
      sendComplete({ imageId: songId }).catch(ignore);
      return false;
    };

    const waitMs = complete();
    if (!waitMs) return;
    const timer = setTimeout(complete, waitMs);
    return () => clearTimeout(timer);
  }, [active, playbackId, songId, listenedSec, durationSec, sendComplete]);
}
