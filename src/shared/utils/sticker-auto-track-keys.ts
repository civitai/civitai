import { normalizeStickerPlacement } from '~/shared/utils/sticker-placement';
import type { StickerTrackKey, StickerTrackV1 } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  wrapDegrees,
  STICKER_TRACK_MAX_DURATION_MS,
  STICKER_TRACK_MAX_KEYS,
} from '~/shared/utils/sticker-track';

/**
 * How long to wait before the next status read of a run, or null to give up. The read has no
 * rate limit of its own, so the schedule is the bound.
 */
export function autoTrackPollDelay(elapsedMs: number): number | null {
  if (elapsedMs < 120_000) return 3000;
  if (elapsedMs < 300_000) return 6000;
  return null;
}

/** How far a dropped key may sit from the line its neighbours draw: x/y fraction, scale, degrees. */
const TOLERANCE = { x: 0.002, y: 0.002, s: 0.005, r: 0.5 };

/**
 * A move within one tick that reads as a scene cut rather than motion: distance as a fraction of
 * the frame per 250 ms, or a scale ratio.
 */
const CUT = { distancePer250Ms: 0.12, scaleRatio: 1.4 };

/** A sticker shown for less than this between hides is a tracker flash, not a sighting. */
const MIN_SHOWN_MS = 400;

/** The show channel with flashes hidden: a shown span shorter than `MIN_SHOWN_MS` that ends in a hide. */
function withoutFlashes(track: StickerTrackV1): StickerTrackV1 {
  if (!track.show) return track;
  const changes = (pairs: [number, number][]) =>
    pairs.filter(([, value], i) => i === 0 || value !== pairs[i - 1][1]);
  // Repeats merged first, so a span is measured from where it starts.
  const show = changes(track.show).map(([tick, value], i, pairs): [number, number] => {
    const next = pairs[i + 1];
    const flash = value === 1 && next?.[1] === 0 && (next[0] - tick) * track.ms < MIN_SHOWN_MS;
    return [tick, flash ? 0 : value];
  });
  return { ...track, show: changes(show) };
}

/** Whether the sticker leaps from `from` to `to`, one tick apart, as it does across a cut. */
function cutBetween(from: StickerTrackKey, to: StickerTrackKey, tickMs: number) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const ratio = Math.max(to.s, from.s) / Math.max(Math.min(to.s, from.s), Number.EPSILON);
  return distance > CUT.distancePer250Ms * Math.max(1, tickMs / 250) || ratio > CUT.scaleRatio;
}

/**
 * A tracker run as keys on the video's clock. Tick 0 is `startMs`. Every tick any channel
 * changes on becomes a key, joined linearly as v1 is. A key jumps instead when its next one
 * shows or hides the sticker, so a hide is a cut and never counts as fading, and when the next
 * tick leaps across the frame or jumps in size, so a scene cut snaps rather than gliding.
 */
export function autoTrackRunKeys(run: StickerTrackV1, startMs: number): StickerTrackKey[] {
  const track = withoutFlashes(run);
  const ticks = new Set<number>();
  for (const pairs of [track.x, track.y, track.s, track.r, track.show ?? []])
    for (const [tick] of pairs) ticks.add(tick);
  // The tick before a show or hide carries the pose up to the cut, since the key there jumps.
  for (const [tick] of track.show ?? []) if (tick > 0) ticks.add(tick - 1);

  const keys: StickerTrackKey[] = [];
  const keyTicks: number[] = [];
  for (const tick of [...ticks].sort((a, b) => a - b)) {
    const t = startMs + Math.round(tick * track.ms);
    if (t > STICKER_TRACK_MAX_DURATION_MS) break;
    const pose = sampleStickerTrack(track, tick * track.ms);
    // The same bounds a placed sticker is held to.
    const { x, y, scale, rotation } = normalizeStickerPlacement(pose);
    keys.push({ t, x, y, s: scale, r: rotation, o: pose.show ? 1 : 0, ease: 'linear' });
    keyTicks.push(tick);
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const seam = (keys[i].o === 0) !== (keys[i + 1].o === 0);
    const leap =
      keyTicks[i + 1] - keyTicks[i] === 1 &&
      keys[i].o === 1 &&
      cutBetween(keys[i], keys[i + 1], track.ms);
    if (seam || leap) keys[i].ease = 'jump';
  }
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

/** `count` keys spread evenly over `keys`, keeping the first and the last. */
const spread = (keys: StickerTrackKey[], count: number) =>
  count >= keys.length
    ? keys
    : Array.from(
        { length: count },
        (_, i) => keys[Math.round((i * (keys.length - 1)) / Math.max(count - 1, 1))]
      );

/** The run's keys thinned to at most `room`, loosening the tolerance until they fit. */
export function fitAutoTrackKeys(keys: StickerTrackKey[], room: number): StickerTrackKey[] {
  if (room <= 0) return [];
  if (room === 1) return keys.slice(0, 1);
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
  if (must.length >= room) return spread(must, room);
  const rest = out.filter((key) => !must.includes(key));
  const step = rest.length / (room - must.length);
  const picked = Array.from({ length: room - must.length }, (_, i) => rest[Math.floor(i * step)]);
  return [...must, ...picked].sort((a, b) => a.t - b.t);
}

/** A key ease that cuts rather than fades when the next key shows or hides the sticker. */
const cutAtSeam = (keys: StickerTrackKey[], i: number) => {
  const from = keys[i];
  const to = keys[i + 1];
  if (from && to && (from.o === 0) !== (to.o === 0)) keys[i] = { ...from, ease: 'jump' };
};

/**
 * The draft's keys with a run added at `startMs`: keys before the run stay, the run's keys
 * replace any it spans, keys after its end stay, and the total stays under the server's cap.
 * The seams cut at a show or hide like the run does, so they never count as fading. Null when
 * the keys outside the run already fill the cap.
 */
export function mergeAutoTrackKeys(
  existing: StickerTrackKey[],
  track: StickerTrackV1,
  startMs: number
): { keys: StickerTrackKey[]; startMs: number; endMs: number } | null {
  const run = autoTrackRunKeys(track, startMs);
  if (!run.length) return null;
  const endMs = run[run.length - 1].t;
  const before = existing.filter((key) => key.t < startMs);
  const after = existing.filter((key) => key.t > endMs);
  const room = STICKER_TRACK_MAX_KEYS - before.length - after.length;
  if (room < 2) return null;
  const keys = [...before, ...fitAutoTrackKeys(run, room), ...after];
  cutAtSeam(keys, before.length - 1);
  cutAtSeam(keys, keys.length - after.length - 1);
  return { keys, startMs, endMs };
}

/** Undoes a run: the keys it spans go back to what they were, edits elsewhere stay. */
export function discardAutoTrackKeys(
  current: StickerTrackKey[],
  previous: StickerTrackKey[],
  span: { startMs: number; endMs: number }
) {
  const inSpan = (key: StickerTrackKey) => key.t >= span.startMs && key.t <= span.endMs;
  return [...current.filter((key) => !inSpan(key)), ...previous.filter(inSpan)].sort(
    (a, b) => a.t - b.t
  );
}
