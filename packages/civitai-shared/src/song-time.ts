// A song's length and playback time, shared by the main app and the moderator app.

/** A song's stored `metadata.duration` as seconds, or null when it is missing or not a positive length. */
export function storedSongDurationSec(duration: unknown): number | null {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : null;
}

/** A playback position or length in seconds as `m:ss`; an unknown or negative time reads `0:00`. */
export function formatPlaybackTime(seconds: number) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
