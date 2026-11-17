import { STICKER_PLACEMENT_MIN_OPACITY } from '~/shared/utils/sticker-placement';
import type { StickerTrackKey, StickerTrackV2 } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  STICKER_TRACK_KEYS_VERSION,
  STICKER_TRACK_MAX_DURATION_MS,
  STICKER_TRACK_MAX_FADE_MS,
  stickerTrackFaintestShown,
  stickerTrackRefusal,
} from '~/shared/utils/sticker-track';

/** The pose a key holds, in the draft's own field names. */
export type KeyPose = { x: number; y: number; scale: number; rotation: number };

/** One frame for the step buttons and arrow keys; Shift steps a second. */
export const STICKER_KEY_STEP_MS = 100;

/**
 * How near the playhead a key must be to be "the key you are on". Half a step, so a step
 * never lands on two keys, and lands on every key at least a step from its neighbours.
 */
export const STICKER_KEY_SNAP_MS = STICKER_KEY_STEP_MS / 2;

const clampTime = (t: number) =>
  Math.min(Math.max(Math.round(t), 0), STICKER_TRACK_MAX_DURATION_MS);

export function keyIndexAt(keys: StickerTrackKey[], t: number) {
  let best = -1;
  for (let i = 0; i < keys.length; i++) {
    const off = Math.abs(keys[i].t - t);
    if (off <= STICKER_KEY_SNAP_MS && (best < 0 || off < Math.abs(keys[best].t - t))) best = i;
  }
  return best;
}

/** The faintest a shown key may be on a sticker drawn at `stickerOpacity`: the two multiply. */
export const keyMinShown = (stickerOpacity: number) =>
  Math.min(STICKER_PLACEMENT_MIN_OPACITY / stickerOpacity, 1);

/** A key opacity the server accepts: hidden, or at least `minShown`, whichever is nearer. */
export const snapKeyOpacity = (o: number, minShown: number) =>
  o >= minShown ? o : o < minShown / 2 ? 0 : minShown;

/**
 * Updates the key at `t`, or adds one. A new key takes the ease and on-screen opacity at that
 * moment, snapped to one the server accepts, so adding a key mid-fade does not refuse the Place.
 */
export function upsertKey(
  keys: StickerTrackKey[],
  t: number,
  pose: Partial<KeyPose>,
  minShown = STICKER_PLACEMENT_MIN_OPACITY
) {
  const at = keyIndexAt(keys, t);
  if (at >= 0) {
    const next = [...keys];
    next[at] = { ...next[at], ...poseFields(pose) };
    return next;
  }
  const time = clampTime(t);
  const here = keys.length ? sampleStickerTrack(trackOf(capFades(keys)), time) : null;
  const before = keys.filter((key) => key.t < time).at(-1);
  const added: StickerTrackKey = {
    t: time,
    x: pose.x ?? here?.x ?? 0.5,
    y: pose.y ?? here?.y ?? 0.5,
    s: pose.scale ?? here?.scale ?? 1,
    r: pose.rotation ?? here?.rotation ?? 0,
    o: here ? snapKeyOpacity(here.opacity, minShown) : 1,
    ease: before?.ease ?? 'smooth',
  };
  return [...keys, added].sort((a, b) => a.t - b.t);
}

/** Changes one key's opacity, ease or time; a retime that lands on another key is ignored. */
export function editKey(
  keys: StickerTrackKey[],
  index: number,
  change: Partial<Pick<StickerTrackKey, 't' | 'o' | 'ease'>>
) {
  const key = keys[index];
  if (!key) return keys;
  const t = change.t == null ? key.t : clampTime(change.t);
  if (keys.some((other, i) => i !== index && other.t === t)) return keys;
  const next = [...keys];
  next[index] = { ...key, ...change, t };
  return next.sort((a, b) => a.t - b.t);
}

export const removeKey = (keys: StickerTrackKey[], index: number) =>
  keys.filter((_, i) => i !== index);

/** The pose the draft shows at `t`, and its key opacity. */
export function poseAt(keys: StickerTrackKey[], t: number) {
  const { x, y, scale, rotation, opacity } = sampleStickerTrack(trackOf(capFades(keys)), t);
  return { pose: { x, y, scale, rotation }, opacity };
}

/**
 * Keys with every fade held to `STICKER_TRACK_MAX_FADE_MS`, the limit the server refuses past.
 * A longer fade waits at the hidden or shown end and fades over the last stretch before the
 * next key, so the sticker still reaches each key's pose at its time. The editor previews the
 * same keys it sends, so what the placer sees is what is stored.
 */
export function capFades(keys: StickerTrackKey[]): StickerTrackKey[] {
  const out: StickerTrackKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    const from = keys[i];
    const to = keys[i + 1];
    out.push(from);
    if (!to || from.ease === 'jump' || (from.o === 0) === (to.o === 0)) continue;
    if (to.t - from.t <= STICKER_TRACK_MAX_FADE_MS) continue;
    const t = to.t - STICKER_TRACK_MAX_FADE_MS;
    const { x, y, scale, rotation } = sampleStickerTrack(trackOf([from, to]), t);
    out.push({ t, x, y, s: scale, r: rotation, o: from.o, ease: from.ease });
  }
  return out;
}

export const stickerKeysTrack = (keys: StickerTrackKey[]): StickerTrackV2 =>
  trackOf(capFades(keys));

export const STICKER_KEYS_TOO_FAINT = 'too faint for the sticker opacity';

/**
 * Why the server's track rules or its opacity floor (key opacity times `stickerOpacity`) would
 * refuse these keys, or null. Null is not a promise of acceptance: the server also checks the
 * creator's size limit and the media type. Run on every render, not when a key is set: changing
 * the sticker's own opacity sets no key.
 */
export function stickerKeysRefusal(keys: StickerTrackKey[], stickerOpacity: number) {
  const track = stickerKeysTrack(keys);
  const faintest = stickerTrackFaintestShown(track);
  if (faintest != null && faintest * stickerOpacity < STICKER_PLACEMENT_MIN_OPACITY - 1e-9)
    return STICKER_KEYS_TOO_FAINT;
  return stickerTrackRefusal(track);
}

const trackOf = (keys: StickerTrackKey[]): StickerTrackV2 => ({
  v: STICKER_TRACK_KEYS_VERSION,
  keys,
});

function poseFields(pose: Partial<KeyPose>): Partial<StickerTrackKey> {
  return {
    ...(pose.x == null ? null : { x: pose.x }),
    ...(pose.y == null ? null : { y: pose.y }),
    ...(pose.scale == null ? null : { s: pose.scale }),
    ...(pose.rotation == null ? null : { r: pose.rotation }),
  };
}
