/**
 * A sticker that moves over a video: its pose over time.
 *
 * `Placement.data` keeps the position, scale and rotation at time zero, so every
 * reader that ignores the track still draws the sticker where it starts. `data`
 * has no visibility: such a reader draws it even where `show` hides it. The track lives in its own
 * column because the feed reads `data` for every card.
 *
 * **Shape.** One channel per value, each a list of `[tick, value]` pairs. A tick
 * is one capture, `ms` milliseconds long, so time is `tick * ms`. The rate is in
 * the header so it can change later without breaking stored tracks.
 *
 * **Collapse.** A channel records a pair only where its value changes, plus the
 * last tick of each held run that a change follows (sampling holds the last
 * value, so a trailing hold needs no closing pair). Between two pairs a continuous channel is linear,
 * so the end of a hold has to be kept or the value would drift across the whole
 * hold instead of moving when the sticker moved. `show` is a step channel and
 * keeps only its change points.
 *
 * Imports only the pose bounds, which are themselves import-free, so schemas and
 * the client can share this without pulling a service graph in.
 */
import {
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export type StickerTrackPair = [tick: number, value: number];

export type StickerTrack = {
  v: 1;
  /** Milliseconds per tick. */
  ms: number;
  /** 1 visible, 0 hidden. Absent means visible for the whole video. */
  show?: StickerTrackPair[];
  x: StickerTrackPair[];
  y: StickerTrackPair[];
  /** Scale, as in `StickerPlacementData.scale`. */
  s: StickerTrackPair[];
  /** Rotation in degrees. */
  r: StickerTrackPair[];
};

export type StickerTrackPose = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  show: boolean;
};

/** One capture, as the recorder takes it. `show` defaults to visible. */
export type StickerTrackSample = Omit<StickerTrackPose, 'show'> & { show?: boolean };

export const STICKER_TRACK_VERSION = 1;
export const STICKER_TRACK_DEFAULT_MS = 100;
export const STICKER_TRACK_MIN_MS = 10;
export const STICKER_TRACK_MAX_TICK_MS = 1000;
/** Above the longest accepted video (`maxVideoDurationSeconds`), so a rounding at the end is not refused. */
export const STICKER_TRACK_MAX_DURATION_MS = 300_000;
/** Of the JSON text: several times a 30 s track that never holds still. */
export const STICKER_TRACK_MAX_BYTES = 128 * 1024;
/**
 * Most pairs one channel can hold inside the byte limit (`[0,0],` is the shortest pair),
 * so a schema refuses a longer array by its length alone. Zod still parses every
 * element first, so this does not bound that work.
 */
export const STICKER_TRACK_MAX_PAIRS = Math.floor(STICKER_TRACK_MAX_BYTES / 6);

const CONTINUOUS_CHANNELS = ['x', 'y', 's', 'r'] as const;
type ContinuousChannel = (typeof CONTINUOUS_CHANNELS)[number];

/** Decimal places per channel; 4 on a 0..1 fraction is sub-pixel at the largest accepted video width. */
const PRECISION: Record<ContinuousChannel, number> = { x: 4, y: 4, s: 4, r: 1 };

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Wraps degrees into [-180, 180). */
const wrapDegrees = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

function collapse(values: number[], step: boolean): StickerTrackPair[] {
  const pairs: StickerTrackPair[] = [];
  const last = values.length - 1;
  for (let i = 0; i <= last; i++) {
    const changed = i === 0 || values[i] !== values[i - 1];
    const endsHold = !step && i < last && values[i] !== values[i + 1];
    if (changed || endsHold) pairs.push([i, values[i]]);
  }
  return pairs;
}

/** `samples[i]` is the pose at tick `i`. */
export function encodeStickerTrack(
  samples: StickerTrackSample[],
  ms: number = STICKER_TRACK_DEFAULT_MS
): StickerTrack {
  if (samples.length === 0) throw new Error('sticker track: no samples');
  const channel = (key: ContinuousChannel, pick: (sample: StickerTrackSample) => number) =>
    collapse(
      samples.map((sample) => {
        const value = pick(sample);
        return round(key === 'r' ? wrapDegrees(value) : value, PRECISION[key]);
      }),
      false
    );

  const show = collapse(
    samples.map((sample) => (sample.show === false ? 0 : 1)),
    true
  );

  return {
    v: STICKER_TRACK_VERSION,
    ms,
    // Omitted when always visible; a track hidden throughout keeps `[[0, 0]]`.
    ...(show.length === 1 && show[0][1] === 1 ? {} : { show }),
    x: channel('x', (sample) => sample.x),
    y: channel('y', (sample) => sample.y),
    s: channel('s', (sample) => sample.scale),
    r: channel('r', (sample) => sample.rotation),
  };
}

/** Index of the last pair at or before `tick`; -1 when `tick` is before the first. */
function pairAtOrBefore(pairs: StickerTrackPair[], tick: number) {
  let low = 0;
  let high = pairs.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (pairs[mid][0] <= tick) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

function sampleContinuous(pairs: StickerTrackPair[], tick: number, angular: boolean) {
  const index = pairAtOrBefore(pairs, tick);
  if (index < 0) return pairs[0][1];
  if (index === pairs.length - 1) return pairs[index][1];
  const [fromTick, from] = pairs[index];
  const [toTick, to] = pairs[index + 1];
  const fraction = (tick - fromTick) / (toTick - fromTick);
  if (!angular) return from + (to - from) * fraction;
  // The shortest way round, so a sticker spun from 170° to -170° turns 20°, not 340°.
  const delta = wrapDegrees(to - from);
  return wrapDegrees(from + delta * fraction);
}

/** The pose at `timeMs` into the video. Before the start it holds the first pose, after the end the last. */
export function sampleStickerTrack(track: StickerTrack, timeMs: number): StickerTrackPose {
  const tick = timeMs / track.ms;
  const showIndex = track.show ? pairAtOrBefore(track.show, tick) : 0;
  return {
    x: sampleContinuous(track.x, tick, false),
    y: sampleContinuous(track.y, tick, false),
    scale: sampleContinuous(track.s, tick, false),
    rotation: sampleContinuous(track.r, tick, true),
    show: track.show ? track.show[Math.max(showIndex, 0)][1] === 1 : true,
  };
}

/** The largest scale anywhere in the track, for the creator's size limit. */
export const stickerTrackMaxScale = (track: StickerTrack) =>
  track.s.reduce((max, [, value]) => Math.max(max, value), 0);

const BOUNDS: Record<ContinuousChannel, [number, number]> = {
  x: [0, 1],
  y: [0, 1],
  s: [STICKER_PLACEMENT_MIN_SCALE, STICKER_PLACEMENT_MAX_SCALE],
  r: [-STICKER_PLACEMENT_MAX_ROTATION, STICKER_PLACEMENT_MAX_ROTATION],
};

/**
 * Why a track is unusable, or null. Refused rather than repaired: a track
 * arrives from the recorder, so a malformed one is a bug or a crafted request,
 * and silently fixing it would store a motion the placer never made.
 *
 * Assumes the shape (numbers in pairs) is already checked, as the zod schema does.
 */
export function stickerTrackRefusal(track: StickerTrack): string | null {
  if (JSON.stringify(track).length > STICKER_TRACK_MAX_BYTES)
    return 'the recorded movement is too long';
  if (track.v !== STICKER_TRACK_VERSION) return 'unknown track version';
  if (
    !Number.isInteger(track.ms) ||
    track.ms < STICKER_TRACK_MIN_MS ||
    track.ms > STICKER_TRACK_MAX_TICK_MS
  )
    return 'unsupported capture rate';

  const maxTick = Math.floor(STICKER_TRACK_MAX_DURATION_MS / track.ms);
  const channels: [string, StickerTrackPair[] | undefined, [number, number] | 'binary'][] = [
    ...CONTINUOUS_CHANNELS.map(
      (key) => [key, track[key], BOUNDS[key]] as [string, StickerTrackPair[], [number, number]]
    ),
    ['show', track.show, 'binary'],
  ];

  for (const [name, pairs, bounds] of channels) {
    if (pairs === undefined && name === 'show') continue;
    if (!pairs || pairs.length === 0) return `${name}: empty`;
    // Every channel starts at zero, so the pose before the first pair is never a guess.
    if (pairs[0][0] !== 0) return `${name}: must start at tick 0`;
    for (let i = 0; i < pairs.length; i++) {
      const [tick, value] = pairs[i];
      if (!Number.isInteger(tick) || tick < 0 || tick > maxTick)
        return `${name}: tick out of range`;
      if (i > 0 && tick <= pairs[i - 1][0]) return `${name}: ticks must increase`;
      if (!Number.isFinite(value)) return `${name}: not a number`;
      if (bounds === 'binary') {
        if (value !== 0 && value !== 1) return `${name}: must be 0 or 1`;
      } else if (value < bounds[0] || value > bounds[1]) return `${name}: out of bounds`;
    }
  }
  return null;
}
