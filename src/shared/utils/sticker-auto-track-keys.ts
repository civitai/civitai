import {
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';
import type { StickerTrackKey, StickerTrackV1 } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  STICKER_TRACK_MAX_DURATION_MS,
  STICKER_TRACK_MAX_KEYS,
} from '~/shared/utils/sticker-track';

/**
 * How long to wait before the next status read of a run, or null to give up. The read has no
 * rate limit of its own, so the schedule is the bound. Runs take about 35 to 90 s.
 */
export function autoTrackPollDelay(elapsedMs: number): number | null {
  if (elapsedMs < 120_000) return 3000;
  if (elapsedMs < 300_000) return 6000;
  return null;
}

/** How far a dropped key may sit from the line its neighbours draw: x/y fraction, scale, degrees. */
const TOLERANCE = { x: 0.002, y: 0.002, s: 0.005, r: 0.5 };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const wrapDegrees = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

/**
 * A tracker run as keys on the video's clock. Tick 0 is `startMs`. Every tick any channel
 * changes on becomes a key, joined linearly as v1 is; a key whose next one shows or hides the
 * sticker jumps, so a hide is a cut and never counts as fading.
 */
export function autoTrackRunKeys(track: StickerTrackV1, startMs: number): StickerTrackKey[] {
  const ticks = new Set<number>();
  for (const pairs of [track.x, track.y, track.s, track.r, track.show ?? []])
    for (const [tick] of pairs) ticks.add(tick);
  // The tick before a show or hide carries the pose up to the cut, since the key there jumps.
  for (const [tick] of track.show ?? []) if (tick > 0) ticks.add(tick - 1);

  const keys: StickerTrackKey[] = [];
  for (const tick of [...ticks].sort((a, b) => a - b)) {
    const t = startMs + Math.round(tick * track.ms);
    if (t > STICKER_TRACK_MAX_DURATION_MS) break;
    const pose = sampleStickerTrack(track, tick * track.ms);
    keys.push({
      t,
      x: clamp(pose.x, 0, 1),
      y: clamp(pose.y, 0, 1),
      s: clamp(pose.scale, STICKER_PLACEMENT_MIN_SCALE, STICKER_PLACEMENT_MAX_SCALE),
      r: clamp(pose.rotation, -STICKER_PLACEMENT_MAX_ROTATION, STICKER_PLACEMENT_MAX_ROTATION),
      o: pose.show ? 1 : 0,
      ease: 'linear',
    });
  }
  for (let i = 0; i < keys.length - 1; i++)
    if ((keys[i].o === 0) !== (keys[i + 1].o === 0)) keys[i].ease = 'jump';
  return keys;
}

/** Whether `mid` lies on the straight line from `from` to `to`, within `scale` times the tolerance. */
function onLine(from: StickerTrackKey, mid: StickerTrackKey, to: StickerTrackKey, scale: number) {
  if (from.ease !== 'linear' || mid.ease !== 'linear' || mid.o !== from.o || to.o !== from.o)
    return false;
  const f = (mid.t - from.t) / (to.t - from.t);
  const r = wrapDegrees(from.r + wrapDegrees(to.r - from.r) * f);
  return (
    Math.abs(from.x + (to.x - from.x) * f - mid.x) <= TOLERANCE.x * scale &&
    Math.abs(from.y + (to.y - from.y) * f - mid.y) <= TOLERANCE.y * scale &&
    Math.abs(from.s + (to.s - from.s) * f - mid.s) <= TOLERANCE.s * scale &&
    Math.abs(wrapDegrees(r - mid.r)) <= TOLERANCE.r * scale
  );
}

/** Drops keys the line between their kept neighbours already draws. Keeps the first and last. */
function thinKeys(keys: StickerTrackKey[], scale: number) {
  if (keys.length <= 2) return keys;
  const kept = [keys[0]];
  let anchor = 0;
  for (let end = 2; end < keys.length; end++) {
    let fits = true;
    for (let mid = anchor + 1; mid < end && fits; mid++)
      fits = onLine(keys[anchor], keys[mid], keys[end], scale);
    if (!fits) {
      anchor = end - 1;
      kept.push(keys[anchor]);
    }
  }
  kept.push(keys[keys.length - 1]);
  return kept;
}

/** The run's keys thinned to at most `room`, loosening the tolerance until they fit. */
export function fitAutoTrackKeys(keys: StickerTrackKey[], room: number): StickerTrackKey[] {
  if (room <= 0) return [];
  let scale = 1;
  let out = thinKeys(keys, scale);
  while (out.length > room && scale < 64) {
    scale *= 2;
    out = thinKeys(keys, scale);
  }
  if (out.length <= room) return out;
  // Still too many: keep every visibility change and the ends, then an even spread.
  const must = out.filter(
    (key, i) => i === 0 || i === out.length - 1 || key.ease === 'jump' || out[i - 1].ease === 'jump'
  );
  if (must.length >= room) return must.slice(0, room);
  const rest = out.filter((key) => !must.includes(key));
  const step = rest.length / (room - must.length);
  const picked = Array.from({ length: room - must.length }, (_, i) => rest[Math.floor(i * step)]);
  return [...must, ...picked].sort((a, b) => a.t - b.t);
}

/**
 * The draft's keys with a run added at `startMs`: keys before the run stay, the run's keys
 * replace any it spans, keys after its end stay, and the total stays under the server's cap.
 */
export function mergeAutoTrackKeys(
  existing: StickerTrackKey[],
  track: StickerTrackV1,
  startMs: number
): StickerTrackKey[] {
  const run = autoTrackRunKeys(track, startMs);
  if (!run.length) return existing;
  const endMs = run[run.length - 1].t;
  const before = existing.filter((key) => key.t < startMs);
  const after = existing.filter((key) => key.t > endMs);
  const fitted = fitAutoTrackKeys(run, STICKER_TRACK_MAX_KEYS - before.length - after.length);
  return [...before, ...fitted, ...after];
}
