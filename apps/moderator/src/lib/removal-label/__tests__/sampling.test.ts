import { describe, expect, it } from 'vitest';
import { allocate, scoreBand, type Candidate } from '../sampling';

const c = (
  imageId: number,
  stratumKey: string,
  ownerId = imageId,
  over: Partial<Candidate> = {}
): Candidate => ({
  imageId,
  ownerId,
  stratum: 'removed',
  stratumKey,
  bucket: 'realisticMinorNsfw',
  nsfwLevel: 'X',
  ...over,
});

describe('allocate', () => {
  it('spreads evenly across strata', () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => c(i, 'a')),
      ...Array.from({ length: 10 }, (_, i) => c(100 + i, 'b')),
    ];
    const picked = allocate(pool, 6, 's');
    expect(picked.filter((p) => p.stratumKey === 'a')).toHaveLength(3);
    expect(picked.filter((p) => p.stratumKey === 'b')).toHaveLength(3);
  });

  it('weights the None/Soft animatedMinorNsfw stratum double', () => {
    const over = Array.from({ length: 20 }, (_, i) =>
      c(i, 'animatedMinorNsfw:Soft', i, { bucket: 'animatedMinorNsfw', nsfwLevel: 'Soft' })
    );
    const plain = Array.from({ length: 20 }, (_, i) => c(100 + i, 'realisticMinorNsfw:X'));
    const picked = allocate([...over, ...plain], 9, 's');
    expect(picked.filter((p) => p.nsfwLevel === 'Soft')).toHaveLength(6);
  });

  it("gives a short stratum's share to the others", () => {
    const picked = allocate(
      [c(1, 'a'), ...Array.from({ length: 10 }, (_, i) => c(100 + i, 'b'))],
      6,
      's'
    );
    expect(picked).toHaveLength(6);
    expect(picked.filter((p) => p.stratumKey === 'a')).toHaveLength(1);
  });

  it('takes at most one image per owner within a stratum', () => {
    const picked = allocate(
      Array.from({ length: 10 }, (_, i) => c(i, 'a', 7)),
      5,
      's'
    );
    expect(picked).toHaveLength(1);
  });

  it('is deterministic for a seed and differs across seeds', () => {
    const pool = Array.from({ length: 50 }, (_, i) => c(i, 'a'));
    const ids = (seed: string) => allocate(pool, 5, seed).map((p) => p.imageId);
    expect(ids('x')).toEqual(ids('x'));
    expect(ids('x')).not.toEqual(ids('y'));
  });
});

describe('helpers', () => {
  it('bands a score by ascending edges', () => {
    expect([0.1, 0.2, 0.6, 0.99].map((s) => scoreBand(s, [0.2, 0.5]))).toEqual([0, 1, 2, 2]);
  });
});
