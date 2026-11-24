import * as z from 'zod';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

const SONG_TIME = /^(\d+):([0-5]\d)$/;

/**
 * The report form's "Time in the song" field: `m:ss` text in, whole seconds out, within the song's
 * length when it is known. The server checks the same bound (`assertSongReportTime`).
 */
export const songReportTimeSchema = (durationSec: number | null) =>
  z
    .string({ error: 'Say when in the song this happens.' })
    .trim()
    .regex(SONG_TIME, 'Enter the time as m:ss, for example 1:05.')
    .transform((time) => {
      const [, mins, secs] = SONG_TIME.exec(time) ?? [];
      return Number(mins) * 60 + Number(secs);
    })
    .refine(
      (sec) => durationSec === null || sec <= durationSec,
      'That time is past the end of the song.'
    );

/** Where a song report starts: the playhead when it is the current song, else the start. */
export const songReportStartSec = (songId: number) =>
  useMusicPlayerStore.getState().current?.id === songId
    ? Math.floor(useMusicPlayheadStore.getState().currentTime)
    : 0;
