/**
 * A sticker's pose over time on a video, in one of two stored versions. Readers handle both.
 *
 * - **v2, keys** (`StickerTrackV2`): the format for keys set by hand. Each key is a time, a whole
 *   pose and an opacity, and an ease that says how the sticker travels to the next key.
 * - **v1, channels** (`StickerTrackV1`): a recorded path or a moment sticker. The placer no longer
 *   writes them, but stored v1 tracks are still read; the builders remain for tests.
 *
 * `Placement.data` keeps the position, scale and rotation at time zero, so every
 * reader that ignores the track still draws the sticker where it starts. `data`
 * has no visibility: such a reader draws it even where the track hides it. The track lives in its
 * own column because the feed reads `data` for every card.
 *
 * **v2 shape.** Keys in increasing time, `t` in whole milliseconds. Before the first key the
 * sticker holds the first key's pose, after the last the last. A key's `o` multiplies the
 * placement's own opacity (`data.opacity`), so 0 hides it and 1 draws it as placed. A key is
 * either hidden or at least the still-sticker floor, after that multiplication (the service
 * checks the product). The curves in
 * `STICKER_TRACK_EASE_CSS` are the CSS the player hands the browser; `sampleStickerTrack`
 * evaluates the same curves, so the server and tests agree with what the browser draws.
 *
 * **v1 shape.** One channel per value, each a list of `[tick, value]` pairs. A tick
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
  STICKER_PLACEMENT_MIN_OPACITY,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export type StickerTrackPair = [tick: number, value: number];

export type StickerTrackV1 = {
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

export const STICKER_TRACK_EASES = ['smooth', 'linear', 'in', 'out', 'jump'] as const;
export type StickerTrackEase = (typeof STICKER_TRACK_EASES)[number];

/** Control points of each eased curve, as in CSS `cubic-bezier(x1, y1, x2, y2)`. */
const EASE_BEZIER: Record<Exclude<StickerTrackEase, 'jump'>, [number, number, number, number]> = {
  smooth: [0.45, 0, 0.55, 1],
  linear: [0, 0, 1, 1],
  in: [0.5, 0, 1, 1],
  out: [0, 0, 0.5, 1],
};

/** The timing function the player gives the browser for each ease. Jump holds, then snaps. */
export const STICKER_TRACK_EASE_CSS: Record<StickerTrackEase, string> = {
  smooth: `cubic-bezier(${EASE_BEZIER.smooth.join(', ')})`,
  linear: 'linear',
  in: `cubic-bezier(${EASE_BEZIER.in.join(', ')})`,
  out: `cubic-bezier(${EASE_BEZIER.out.join(', ')})`,
  jump: 'steps(1, end)',
};

export type StickerTrackKey = {
  /** Milliseconds into the video. */
  t: number;
  x: number;
  y: number;
  /** Scale, as in `StickerPlacementData.scale`. */
  s: number;
  /** Rotation in degrees. */
  r: number;
  /** 0 to 1, times the placement's own opacity. */
  o: number;
  /** How the sticker travels from this key to the next. Ignored on the last key. */
  ease: StickerTrackEase;
};

export type StickerTrackV2 = { v: 2; keys: StickerTrackKey[] };

export type StickerTrack = StickerTrackV1 | StickerTrackV2;

export type StickerTrackPose = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** 0 to 1, times the placement's own opacity. A v1 track is 1 where shown and 0 where hidden. */
  opacity: number;
  /** `opacity > 0`. */
  show: boolean;
};

/** One capture of a pose. `show` defaults to visible. */
export type StickerTrackSample = Omit<StickerTrackPose, 'show' | 'opacity'> & { show?: boolean };

export const STICKER_TRACK_VERSION = 1;
export const STICKER_TRACK_KEYS_VERSION = 2;
/** Far more keys than anyone sets by hand, and inside the byte limit at full precision. */
export const STICKER_TRACK_MAX_KEYS = 500;
export const STICKER_TRACK_DEFAULT_MS = 100;
export const STICKER_TRACK_MIN_MS = 10;
export const STICKER_TRACK_MAX_TICK_MS = 1000;
/** Above the longest accepted video (`maxVideoDurationSeconds`), so a rounding at the end is not refused. */
export const STICKER_TRACK_MAX_DURATION_MS = 500_000;
/**
 * Longest a segment may fade between a hidden key and a shown one. A fade can be drawn below the
 * opacity floor for up to its whole length, so this and `STICKER_TRACK_MAX_FAINT_MS` bound how
 * long a sticker can sit faint.
 */
export const STICKER_TRACK_MAX_FADE_MS = 2000;
/** Longest the fades of one track may last in all, so chained fades cannot keep a sticker faint either. */
export const STICKER_TRACK_MAX_FAINT_MS = 8000;
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
): StickerTrackV1 {
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

/** One pose, shown for `durationMs` from `startMs` and hidden the rest of the video. */
export function momentStickerTrack(
  pose: Omit<StickerTrackPose, 'show' | 'opacity'>,
  startMs: number,
  durationMs: number
): StickerTrackV1 {
  const startTick = Math.round(startMs / STICKER_TRACK_DEFAULT_MS);
  const endTick = startTick + Math.max(1, Math.round(durationMs / STICKER_TRACK_DEFAULT_MS));
  const samples: StickerTrackSample[] = [];
  for (let tick = 0; tick <= endTick; tick++)
    samples.push({ ...pose, show: tick >= startTick && tick < endTick });
  return encodeStickerTrack(samples);
}

/** Index of the last item whose time is at or before `time`; -1 when `time` is before the first. */
function lastAtOrBefore<T>(items: T[], time: number, timeOf: (item: T) => number) {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeOf(items[mid]) <= time) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

const pairTick = ([tick]: StickerTrackPair) => tick;

function sampleContinuous(pairs: StickerTrackPair[], tick: number, angular: boolean) {
  const index = lastAtOrBefore(pairs, tick, pairTick);
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

/** A v1 pose; v1 has no partial opacity, so a shown sticker is drawn as placed. */
function sampleChannels(track: StickerTrackV1, timeMs: number): StickerTrackPose {
  const tick = timeMs / track.ms;
  const showIndex = track.show ? lastAtOrBefore(track.show, tick, pairTick) : 0;
  const show = track.show ? track.show[Math.max(showIndex, 0)][1] === 1 : true;
  return {
    x: sampleContinuous(track.x, tick, false),
    y: sampleContinuous(track.y, tick, false),
    scale: sampleContinuous(track.s, tick, false),
    rotation: sampleContinuous(track.r, tick, true),
    opacity: show ? 1 : 0,
    show,
  };
}

/** `cubic-bezier(x1, y1, x2, y2)` at progress `x`, the way a browser evaluates it. */
function cubicBezier([x1, y1, x2, y2]: [number, number, number, number], x: number) {
  const at = (u: number, a: number, b: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  // x(u) increases on [0, 1] for every curve here (x1 and x2 in [0, 1]), so bisection finds u.
  let low = 0;
  let high = 1;
  let u = x;
  for (let i = 0; i < 40; i++) {
    const guess = at(u, x1, x2);
    if (Math.abs(guess - x) < 1e-7) break;
    if (guess < x) low = u;
    else high = u;
    u = (low + high) / 2;
  }
  return at(u, y1, y2);
}

/** Eased progress through a segment, `fraction` in [0, 1). */
export function easeStickerTrack(ease: StickerTrackEase, fraction: number) {
  if (ease === 'jump') return 0;
  if (ease === 'linear') return fraction;
  return cubicBezier(EASE_BEZIER[ease], fraction);
}

const keyPose = ({ x, y, s, r, o }: StickerTrackKey): StickerTrackPose => ({
  x,
  y,
  scale: s,
  rotation: r,
  opacity: o,
  show: o > 0,
});

function sampleKeys({ keys }: StickerTrackV2, timeMs: number): StickerTrackPose {
  const index = lastAtOrBefore(keys, timeMs, (key) => key.t);
  if (index < 0) return keyPose(keys[0]);
  if (index === keys.length - 1) return keyPose(keys[index]);
  const from = keys[index];
  const to = keys[index + 1];
  const eased = easeStickerTrack(from.ease, (timeMs - from.t) / (to.t - from.t));
  const lerp = (a: number, b: number) => a + (b - a) * eased;
  const opacity = lerp(from.o, to.o);
  return {
    x: lerp(from.x, to.x),
    y: lerp(from.y, to.y),
    scale: lerp(from.s, to.s),
    // The shortest way round, as v1 turns.
    rotation: wrapDegrees(from.r + wrapDegrees(to.r - from.r) * eased),
    opacity,
    show: opacity > 0,
  };
}

/** The pose at `timeMs` into the video. Before the start it holds the first pose, after the end the last. */
export function sampleStickerTrack(track: StickerTrack, timeMs: number): StickerTrackPose {
  return track.v === STICKER_TRACK_KEYS_VERSION
    ? sampleKeys(track, timeMs)
    : sampleChannels(track, timeMs);
}

/** One keyframe for the player. `rotation` is unwrapped, so the browser turns the short way. */
export type StickerTrackFrame = {
  /** 0 to 1 through `duration`. Two frames may share one, for an instant change. */
  offset: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** The CSS timing function to the next frame. */
  easing: string;
};

/**
 * The track as keyframes over `duration` ms, for a Web Animation clocked by the video. Starts at
 * offset 0 and ends at 1 explicitly: a browser fills a missing end from the element's own style,
 * which is the stored start pose, not the track.
 */
export function stickerTrackFrames(track: StickerTrack): {
  duration: number;
  frames: StickerTrackFrame[];
} {
  const points: { t: number; pose: StickerTrackPose; easing: string }[] = [];
  if (track.v === STICKER_TRACK_KEYS_VERSION) {
    const first = track.keys[0];
    if (first.t > 0) points.push({ t: 0, pose: keyPose(first), easing: 'linear' });
    for (const key of track.keys)
      points.push({ t: key.t, pose: keyPose(key), easing: STICKER_TRACK_EASE_CSS[key.ease] });
  } else {
    // Each channel is linear between its own pairs, so straight lines between the poses at
    // every tick any channel changes on trace the same path.
    const ticks = new Set<number>();
    for (const channel of [...CONTINUOUS_CHANNELS, 'show'] as const)
      for (const [tick] of track[channel] ?? []) ticks.add(tick);
    for (const tick of [...ticks].sort((a, b) => a - b)) {
      const t = tick * track.ms;
      const pose = sampleChannels(track, t);
      const previous = points[points.length - 1];
      // `show` steps: hold the old visibility up to the tick, then change at it.
      if (previous && previous.pose.show !== pose.show)
        points.push({
          t,
          pose: { ...pose, opacity: previous.pose.opacity, show: previous.pose.show },
          easing: 'linear',
        });
      points.push({ t, pose, easing: 'linear' });
    }
  }

  const end = points[points.length - 1].t;
  if (end === 0) points.push({ ...points[points.length - 1], t: 1 });
  const duration = Math.max(end, 1);

  let rotation = points[0].pose.rotation;
  return {
    duration,
    frames: points.map(({ t, pose, easing }, i) => {
      if (i > 0) rotation += wrapDegrees(pose.rotation - points[i - 1].pose.rotation);
      return {
        offset: t / duration,
        x: pose.x,
        y: pose.y,
        scale: pose.scale,
        rotation,
        opacity: pose.opacity,
        easing,
      };
    }),
  };
}

/** The largest scale anywhere in the track, for the creator's size limit. No ease overshoots. */
export const stickerTrackMaxScale = (track: StickerTrack) =>
  track.v === STICKER_TRACK_KEYS_VERSION
    ? track.keys.reduce((max, key) => Math.max(max, key.s), 0)
    : track.s.reduce((max, [, value]) => Math.max(max, value), 0);

/** The faintest key the sticker is shown at, before the placement's own opacity; null if none. */
export const stickerTrackFaintestShown = (track: StickerTrack) =>
  track.v === STICKER_TRACK_KEYS_VERSION
    ? track.keys.reduce<number | null>(
        (min, key) => (key.o > 0 && (min === null || key.o < min) ? key.o : min),
        null
      )
    : null;

/** Whether position, size or turn change over the track; opacity alone does not count. */
export const stickerTrackMoves = (track: StickerTrack) => {
  if (track.v !== STICKER_TRACK_KEYS_VERSION)
    return CONTINUOUS_CHANNELS.some((channel) => track[channel].length > 1);
  const [first, ...rest] = track.keys;
  return rest.some(
    (key) => key.x !== first.x || key.y !== first.y || key.s !== first.s || key.r !== first.r
  );
};

/**
 * Whether the player draws the track: it moves, or (v2) its opacity is ever below 1. A v1 track
 * that only hides is drawn by hiding the sticker (`show`), as before.
 */
export const stickerTrackAnimates = (track: StickerTrack) =>
  stickerTrackMoves(track) ||
  (track.v === STICKER_TRACK_KEYS_VERSION && track.keys.some((key) => key.o !== 1));

const BOUNDS: Record<ContinuousChannel, [number, number]> = {
  x: [0, 1],
  y: [0, 1],
  s: [STICKER_PLACEMENT_MIN_SCALE, STICKER_PLACEMENT_MAX_SCALE],
  r: [-STICKER_PLACEMENT_MAX_ROTATION, STICKER_PLACEMENT_MAX_ROTATION],
};

const KEY_BOUNDS: [Exclude<keyof StickerTrackKey, 't' | 'ease'>, [number, number]][] = [
  ['x', BOUNDS.x],
  ['y', BOUNDS.y],
  ['s', BOUNDS.s],
  ['r', BOUNDS.r],
  ['o', [0, 1]],
];

/** A segment drawn faint: one end hidden, the other shown, eased rather than snapped. */
const fadesFaint = (from: StickerTrackKey, to: StickerTrackKey) =>
  from.ease !== 'jump' && (from.o === 0) !== (to.o === 0);

function keysRefusal(keys: StickerTrackKey[]): string | null {
  if (keys.length === 0) return 'keys: empty';
  if (keys.length > STICKER_TRACK_MAX_KEYS) return 'too many keys';
  let faintMs = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!Number.isInteger(key.t) || key.t < 0 || key.t > STICKER_TRACK_MAX_DURATION_MS)
      return 'keys: time out of range';
    if (i > 0 && key.t <= keys[i - 1].t) return 'keys: times must increase';
    for (const [name, [min, max]] of KEY_BOUNDS) {
      const value = key[name];
      if (!Number.isFinite(value)) return `keys: ${name} not a number`;
      if (value < min || value > max) return `keys: ${name} out of bounds`;
    }
    // Hidden, or at least as strong as a placer may make a still sticker: the floor's reasons
    // (`STICKER_PLACEMENT_MIN_OPACITY`) hold for a key the sticker rests on. A fade passes
    // through fainter values on its way to 0, which is the point of a fade.
    if (key.o !== 0 && key.o < STICKER_PLACEMENT_MIN_OPACITY) return 'keys: o too faint';
    if (!STICKER_TRACK_EASES.includes(key.ease)) return 'keys: unknown ease';
    if (i > 0 && fadesFaint(keys[i - 1], key)) {
      const fadeMs = key.t - keys[i - 1].t;
      if (fadeMs > STICKER_TRACK_MAX_FADE_MS) return 'keys: fade too long';
      faintMs += fadeMs;
      if (faintMs > STICKER_TRACK_MAX_FAINT_MS) return 'keys: too much fading';
    }
  }
  return null;
}

/**
 * Why a track is unusable, or null. Refused rather than repaired: a track
 * arrives from the client's encoder, so a malformed one is a bug or a crafted request,
 * and silently fixing it would store a motion the placer never made.
 *
 * Assumes the shape (numbers in pairs, fields on keys) is already checked, as the zod schema does.
 */
export function stickerTrackRefusal(track: StickerTrack): string | null {
  if (JSON.stringify(track).length > STICKER_TRACK_MAX_BYTES)
    return 'the recorded movement is too long';
  if (track.v === STICKER_TRACK_KEYS_VERSION) return keysRefusal(track.keys);
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
