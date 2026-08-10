import { describe, expect, it } from 'vitest';
import { bucketReactors } from '../../analytics/reaction-audience';

const OWNER = 1818607;

const sum = (s: ReturnType<typeof bucketReactors>) =>
  s.followers.reactions + s.nonFollowers.reactions + s.self.reactions;

describe('bucketReactors', () => {
  it('splits reactions by follow state and breaks out the creator', () => {
    const split = bucketReactors(
      [
        { id: 1, reactions: 10 },
        { id: 2, reactions: 5 },
        { id: 3, reactions: 7 },
        { id: OWNER, reactions: 3 },
      ],
      OWNER,
      new Set([1, 2])
    );

    expect(split.followers).toEqual({ reactions: 15, reactors: 2 });
    expect(split.nonFollowers).toEqual({ reactions: 7, reactors: 1 });
    expect(split.self).toEqual({ reactions: 3, reactors: 1 });
  });

  // The panel sits next to the page's "Reactions received" total. If the buckets can't add back up to it, the two
  // numbers contradict each other on the same screen — which is the shape of bug creators report as lost money.
  it('sums to the reactions total even with self, anonymous and net-negative reactors', () => {
    const reactors = [
      { id: 1, reactions: 10 },
      { id: 2, reactions: -4 },
      { id: 3, reactions: 0 },
      { id: 0, reactions: 2 },
      { id: OWNER, reactions: 6 },
    ];
    const split = bucketReactors(reactors, OWNER, new Set([1, 2]));

    expect(sum(split)).toBe(reactors.reduce((acc, r) => acc + r.reactions, 0));
    expect(sum(split)).toBe(14);
  });

  it('counts a reactor only when their net over the range is positive', () => {
    const split = bucketReactors(
      [
        { id: 1, reactions: -4 },
        { id: 2, reactions: 0 },
        { id: 3, reactions: 1 },
      ],
      OWNER,
      new Set([1, 2, 3])
    );

    expect(split.followers.reactors).toBe(1);
    expect(split.followers.reactions).toBe(-3);
  });

  it('treats an actorless reaction as not following', () => {
    const split = bucketReactors([{ id: 0, reactions: 5 }], OWNER, new Set());

    expect(split.nonFollowers).toEqual({ reactions: 5, reactors: 1 });
    expect(split.followers.reactions).toBe(0);
  });
});
