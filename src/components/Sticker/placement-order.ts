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

/** The shortest gap that reads as a pause rather than as a stagger. */
const BASE_STEP_MS = 140;
/** The longest one sticker may hold the screen before the next arrives. */
const MAX_STEP_MS = 700;
/**
 * A whole build has to stay watchable. An image with forty stickers at the
 * uncapped step would run the better part of a minute, and the reveal plays
 * every time the detail view shows the stickers.
 */
const MAX_TOTAL_MS = 3_000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Milliseconds to hold each sticker back, in the order given.
 *
 * Time-dilated: a bigger real gap between two placements is a longer pause, so
 * an image built over a week plays back as bursts with lulls rather than as an
 * even drum roll. Log-scaled against an hour, because the interesting range
 * spans minutes to weeks and a linear map turns everything below a day into the
 * same instant.
 *
 * The whole sequence is then scaled to fit `MAX_TOTAL_MS` rather than truncated:
 * dropping the tail would leave the last stickers — the ones on top, the ones
 * someone deliberately placed over another — arriving with no reveal at all.
 *
 * Callers pass placements already ordered. This does not sort, so a caller that
 * skipped `orderPlacements` gets delays matching the order it actually draws.
 */
export function placementRevealDelays(
  placements: Ordered[],
  { maxTotalMs = MAX_TOTAL_MS }: { maxTotalMs?: number } = {}
): number[] {
  if (placements.length <= 1) return placements.map(() => 0);

  const delays: number[] = [0];
  for (let i = 1; i < placements.length; i++) {
    const gap = Math.max(0, time(placements[i].placedAt) - time(placements[i - 1].placedAt));
    const step = Math.min(MAX_STEP_MS, BASE_STEP_MS * (1 + Math.log10(1 + gap / HOUR_MS)));
    delays.push(delays[i - 1] + step);
  }

  const total = delays[delays.length - 1];
  // `total` is 0 only when every step was 0, which the clamp above cannot
  // produce — but a caller passing its own bounds could, and a 0/0 scale would
  // put every sticker at NaN and hold the whole layer at the animation's first
  // frame.
  if (total <= maxTotalMs || total === 0) return delays.map(Math.round);

  const scale = maxTotalMs / total;
  return delays.map((delay) => Math.round(delay * scale));
}
