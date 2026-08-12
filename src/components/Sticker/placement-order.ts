/**
 * The order stickers were placed in, and the pacing of the reveal built on it.
 *
 * Pure and separate from anything that renders so both rules are testable: the
 * layer order decides what covers what, which is the whole reason placing a hat
 * on someone else's sticker works, and a bug there is invisible until two
 * stickers overlap.
 */

type Ordered = { id: number; placedAt: Date | string };

const time = (value: Date | string) => new Date(value).getTime();

/**
 * Oldest first, so the last one placed draws on top.
 *
 * The server already returns them this way; this is what makes the ordering a
 * property of the layer rather than of the query that fed it. A cache written
 * by hand, an optimistic insert, or a second caller that forgets the `orderBy`
 * all reorder the array without touching this file, and the failure looks like
 * a sticker mysteriously behind another one rather than like a bad query.
 *
 * `id` breaks a tie: two placements can share a millisecond, and a comparator
 * that returns 0 leaves their order to the input, which is the thing being
 * defended against.
 */
export function orderPlacements<T extends Ordered>(placements: T[]): T[] {
  return [...placements].sort((a, b) => time(a.placedAt) - time(b.placedAt) || a.id - b.id);
}

/**
 * The shortest gap that reads as a pause rather than as a stagger, and the
 * longest one sticker may hold the screen. These two set the SHAPE of the
 * sequence — how much longer a week-long gap looks than a five-minute one. The
 * duration below sets its LENGTH, and the shape is stretched to fit it.
 */
const BASE_STEP_MS = 140;
const MAX_STEP_MS = 700;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The reveal is as long as the history is old.
 *
 * A fixed duration made the setting meaningless in both directions: two
 * stickers placed a minute apart stretched across twelve seconds of nothing
 * happening, while a year-long build got the same twelve seconds as an
 * afternoon's. The length now comes from the real span between the first and
 * last placement, so "this took a while" is carried by the reveal itself and
 * the viewer's setting is a multiplier on top rather than the whole answer.
 *
 * A floor because a burst still needs long enough to read as a sequence; a cap
 * because nobody watches a reveal past a few seconds, and past a year the
 * difference stops meaning anything anyway.
 */
const FLOOR_MS = 1_500;
const CAP_MS = 12_000;
/** Where the cap is reached. A year of history is as old as the reveal shows. */
const CAP_SPAN_DAYS = 365;

export function revealDurationForSpan(spanMs: number, multiplier = 1): number {
  const days = Math.max(0, spanMs) / DAY_MS;
  // Log-scaled, and flat below a day: within a single day the gaps are what
  // carry the pacing, and stretching an afternoon's worth of stickers past the
  // floor buys nothing.
  const aged = days <= 1 ? 0 : Math.min(1, Math.log10(days) / Math.log10(CAP_SPAN_DAYS));
  return (FLOOR_MS + (CAP_MS - FLOOR_MS) * aged) * multiplier;
}

/**
 * Milliseconds to hold each sticker back, in the order given.
 *
 * Time-dilated: a bigger real gap between two placements is a longer pause, so
 * an image built over a week plays back as bursts with lulls rather than as an
 * even drum roll. Log-scaled against an hour, because the interesting range
 * spans minutes to weeks and a linear map turns everything below a day into the
 * same instant.
 *
 * The sequence is then stretched — or squeezed — to exactly the length the
 * history has earned (see `revealDurationForSpan`). Both directions: two
 * stickers a minute apart are worth 0.3s of raw sequence, so scaling only
 * downwards left every setting looking the same on any image that was not
 * heavily stickered. Scaling never truncates either, because the tail is the
 * part someone deliberately placed over another.
 *
 * What the dilation survives as is the RATIO between the gaps: a week-long pause
 * still runs several times longer than a five-minute one, whatever length the
 * whole thing is given.
 *
 * Callers pass placements already ordered. This does not sort, so a caller that
 * skipped `orderPlacements` gets delays matching the order it actually draws.
 */
export function placementRevealDelays(
  placements: Ordered[],
  {
    multiplier = 1,
    totalMs,
  }: {
    /** The viewer's speed setting, applied on top of the span-derived length. */
    multiplier?: number;
    /** An explicit length, for a caller that has already decided one. */
    totalMs?: number;
  } = {}
): number[] {
  if (placements.length <= 1) return placements.map(() => 0);

  const span = time(placements[placements.length - 1].placedAt) - time(placements[0].placedAt);
  const length = totalMs ?? revealDurationForSpan(span, multiplier);

  const delays: number[] = [0];
  for (let i = 1; i < placements.length; i++) {
    const gap = Math.max(0, time(placements[i].placedAt) - time(placements[i - 1].placedAt));
    const step = Math.min(MAX_STEP_MS, BASE_STEP_MS * (1 + Math.log10(1 + gap / HOUR_MS)));
    delays.push(delays[i - 1] + step);
  }

  const total = delays[delays.length - 1];
  // `total` is 0 only if every step was 0, which the clamp above cannot produce
  // — but a caller passing its own bounds could, and 0/0 would put every sticker
  // at NaN and hold the whole layer at the animation's first frame.
  if (total === 0) return delays.map(() => 0);

  const scale = length / total;
  return delays.map((delay) => Math.round(delay * scale));
}
