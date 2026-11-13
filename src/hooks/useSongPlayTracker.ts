import { useEffect, useRef } from 'react';
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
};

type PlaybackId = string | number;

const ignore = () => undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `report` after every report queued before it, failed or not. */
function enqueue(queue: { current: Promise<unknown> }, report: () => Promise<unknown>) {
  queue.current = queue.current.then(report).catch(ignore);
}

/**
 * `timeupdate` fires only a few times a second, so the last listen report of a song can fall just
 * short of its end. Only a song shorter than the 30 s rule needs to be heard to its end.
 */
const END_OF_SONG_SLACK_SEC = 1;

function reachedPlayRule(listenedSec: number, durationSec: number | null | undefined) {
  if (isCountablePlay(listenedSec, durationSec)) return true;
  const wholeSong = durationSec != null && songPlayThresholdSec(durationSec) === durationSec;
  return wholeSong && isCountablePlay(listenedSec + END_OF_SONG_SLACK_SEC, durationSec);
}

/**
 * Reports a playback to the server: a start when it begins, then one complete when the play rule
 * is met. The server decides what counts (`song-play.service`); a lost report is never surfaced.
 *
 * The complete also waits until the rule's time has passed since the start was answered, so the
 * server, which measures from when it recorded the start, has reached it too. That wait outlives
 * the playback (a short song ends inside it), and every report goes out in order, because the
 * server keeps one start per listener and song: a replay's start must not overtake the complete.
 */
export function useSongPlayTracker({
  songId,
  playbackId,
  durationSec,
  listenedSec,
  enabled,
}: SongPlayTrackerInput) {
  const { mutateAsync: sendStart } = trpc.track.songPlayStart.useMutation();
  const { mutateAsync: sendComplete } = trpc.track.songPlay.useMutation();

  const startedFor = useRef<PlaybackId | null>(null);
  const acknowledged = useRef<{ playbackId: PlaybackId; at: number } | null>(null);
  const completedFor = useRef<PlaybackId | null>(null);
  const reports = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!enabled || songId == null || playbackId == null) return;
    if (startedFor.current === playbackId) return;
    startedFor.current = playbackId;
    enqueue(reports, () =>
      sendStart({ imageId: songId }).then((result) => {
        if (result?.started) acknowledged.current = { playbackId, at: Date.now() };
      })
    );
  }, [enabled, playbackId, songId, sendStart]);

  useEffect(() => {
    if (!enabled || songId == null || playbackId == null) return;
    if (completedFor.current === playbackId) return;
    if (!reachedPlayRule(listenedSec, durationSec)) return;
    const ack = acknowledged.current;
    if (!ack || ack.playbackId !== playbackId) return;

    completedFor.current = playbackId;
    const waitMs = ack.at + songPlayThresholdSec(durationSec) * 1000 - Date.now();
    enqueue(reports, async () => {
      if (waitMs > 0) await sleep(waitMs);
      await sendComplete({ imageId: songId });
    });
  }, [enabled, playbackId, songId, listenedSec, durationSec, sendComplete]);
}
