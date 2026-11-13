/** "Play = 30 s listened or full track if shorter". */
export const SONG_PLAY_MIN_LISTEN_SEC = 30;

/** Seconds a playback must reach to count: the whole song when shorter than 30 s, else 30 s. */
export function songPlayThresholdSec(durationSec: number | null | undefined) {
  const known = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  return known ? Math.min(SONG_PLAY_MIN_LISTEN_SEC, durationSec) : SONG_PLAY_MIN_LISTEN_SEC;
}

/**
 * Whether `listenedSec` of a song counts as a play. The client asks it of audio actually played;
 * the server asks it of its own clock since the playback's start.
 */
export function isCountablePlay(listenedSec: number, durationSec: number | null | undefined) {
  return Number.isFinite(listenedSec) && listenedSec >= songPlayThresholdSec(durationSec);
}
