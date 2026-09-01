// Not a zustand store on purpose: writes land on every `timeupdate` and nothing renders from
// this, so a reactive store would add subscriber churn for no reader.

const RESUME_WINDOW_MS = 60_000;
const MAX_TRACKED = 50;

type Position = { time: number; at: number };

const positions = new Map<number, Position>();

export function recordVideoPosition(imageId: number, time: number) {
  // `stop()` zeroes currentTime before unmount, and a video at 0 has nothing to resume to —
  // dropping those keeps the reset from overwriting the position we just captured.
  if (!(time > 0)) return;

  // Re-insert so iteration order stays newest-last, which is what the eviction below pops from.
  positions.delete(imageId);
  positions.set(imageId, { time, at: Date.now() });

  if (positions.size > MAX_TRACKED) {
    const oldest = positions.keys().next();
    if (!oldest.done) positions.delete(oldest.value);
  }
}

export function getVideoPosition(imageId: number) {
  const stored = positions.get(imageId);
  if (!stored) return undefined;
  if (Date.now() - stored.at > RESUME_WINDOW_MS) {
    positions.delete(imageId);
    return undefined;
  }
  return stored.time;
}

export function clearVideoPositions() {
  positions.clear();
}
