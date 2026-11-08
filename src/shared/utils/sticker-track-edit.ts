import type { StickerTrackKey, StickerTrackV2 } from '~/shared/utils/sticker-track';
import {
  sampleStickerTrack,
  STICKER_TRACK_KEYS_VERSION,
  STICKER_TRACK_MAX_DURATION_MS,
  STICKER_TRACK_MAX_FADE_MS,
} from '~/shared/utils/sticker-track';

/** The pose a key holds, in the draft's own field names. */
export type KeyPose = { x: number; y: number; scale: number; rotation: number };

/** One frame for the step buttons and arrow keys; Shift steps a second. */
export const STICKER_KEY_STEP_MS = 100;

/**
 * How near the playhead a key must be to be "the key you are on". Half a step, so stepping
 * frame by frame lands on each key and never on two.
 */
export const STICKER_KEY_SNAP_MS = STICKER_KEY_STEP_MS / 2;

const clampTime = (t: number) =>
  Math.min(Math.max(Math.round(t), 0), STICKER_TRACK_MAX_DURATION_MS);

/** The index of the key at the playhead, or -1. */
export function keyIndexAt(keys: StickerTrackKey[], t: number) {
  let best = -1;
  for (let i = 0; i < keys.length; i++) {
    const off = Math.abs(keys[i].t - t);
    if (off <= STICKER_KEY_SNAP_MS && (best < 0 || off < Math.abs(keys[best].t - t))) best = i;
  }
  return best;
}

/**
 * Sets a key at `t` to `pose`: updates the key you are on, or adds one there. A new key takes
 * the opacity and ease the sticker has at that moment, so adding a key never changes the motion
 * around it.
 */
export function upsertKey(keys: StickerTrackKey[], t: number, pose: Partial<KeyPose>) {
  const at = keyIndexAt(keys, t);
  if (at >= 0) {
    const next = [...keys];
    next[at] = { ...next[at], ...poseFields(pose) };
    return next;
  }
  const time = clampTime(t);
  const here = keys.length ? sampleStickerTrack(trackOf(keys), time) : null;
  const before = keys.filter((key) => key.t < time).at(-1);
  const added: StickerTrackKey = {
    t: time,
    x: pose.x ?? here?.x ?? 0.5,
    y: pose.y ?? here?.y ?? 0.5,
    s: pose.scale ?? here?.scale ?? 1,
    r: pose.rotation ?? here?.rotation ?? 0,
    o: here?.opacity ?? 1,
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

/** The track a draft's keys are stored as. */
export const stickerKeysTrack = (keys: StickerTrackKey[]): StickerTrackV2 =>
  trackOf(capFades(keys));

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
