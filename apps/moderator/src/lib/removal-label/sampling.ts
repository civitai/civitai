import { createHash } from 'node:crypto';
import { MINOR_BUCKETS, type MinorBucket } from './compose';

export type Candidate = {
  imageId: number;
  ownerId: number;
  stratum: 'removed' | 'not_removed';
  /** Removed: `<bucket>:<level>`. Not removed: `band<i>:<level>`. */
  stratumKey: string;
  bucket: MinorBucket | null;
  nsfwLevel: string;
};

export const isMinorBucket = (v: string | null | undefined): v is MinorBucket =>
  !!v && (MINOR_BUCKETS as readonly string[]).includes(v);

/** Which band a score falls in, given ascending inner edges. `[0.2, 0.5]` gives bands 0, 1, 2. */
export function scoreBand(score: number, edges: number[]): number {
  let band = 0;
  for (const edge of edges) if (score >= edge) band++;
  return band;
}

/**
 * The stratum the design says to oversample: animatedMinorNsfw removals that were None or Soft
 * before removal, the likeliest "mature means not sexual" cases.
 */
export const isOversampled = (c: Candidate) =>
  c.bucket === 'animatedMinorNsfw' && (c.nsfwLevel === 'None' || c.nsfwLevel === 'Soft');

const rank = (seed: string, imageId: number) =>
  createHash('sha256').update(`${seed}:${imageId}`).digest('hex');

/**
 * Picks `total` candidates spread evenly across strata, with oversampled strata weighted double.
 * A stratum with fewer candidates than its share gives the remainder back to the others, so a short
 * stratum is visible in the result rather than padded. Deterministic for a given seed. At most one
 * image per owner within a stratum, so a single prolific uploader cannot fill one.
 */
export function allocate(candidates: Candidate[], total: number, seed: string): Candidate[] {
  const strata = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = strata.get(c.stratumKey);
    if (list) list.push(c);
    else strata.set(c.stratumKey, [c]);
  }

  const pools = [...strata.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const seenOwners = new Set<number>();
      const ordered = list
        .map((c) => ({ c, r: rank(seed, c.imageId) }))
        .sort((a, b) => a.r.localeCompare(b.r))
        .map((x) => x.c)
        .filter((c) => !seenOwners.has(c.ownerId) && seenOwners.add(c.ownerId));
      return { key, ordered, weight: ordered.some(isOversampled) ? 2 : 1, taken: 0 };
    });

  let remaining = total;
  let open = pools.filter((p) => p.ordered.length > 0);
  while (remaining > 0 && open.length) {
    const weightSum = open.reduce((s, p) => s + p.weight, 0);
    const roundTotal = remaining;
    let progressed = false;
    for (const p of open) {
      const share = Math.max(1, Math.floor((roundTotal * p.weight) / weightSum));
      const take = Math.min(share, p.ordered.length - p.taken, remaining);
      if (take > 0) {
        p.taken += take;
        remaining -= take;
        progressed = true;
      }
      if (remaining === 0) break;
    }
    open = open.filter((p) => p.taken < p.ordered.length);
    if (!progressed) break;
  }

  return pools.flatMap((p) => p.ordered.slice(0, p.taken));
}
