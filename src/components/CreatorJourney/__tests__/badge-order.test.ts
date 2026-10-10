import { describe, expect, it } from 'vitest';
import { sortEarnedBadges } from '~/components/CreatorJourney/badge-order';
import { milestoneRung } from '~/server/services/creator-milestone-registry';

const badge = (key: string, achievedAt: Date | null = null, track = key.split(':')[0]) => ({
  key,
  track,
  achievedAt,
});
const keys = (badges: { key: string }[]) => sortEarnedBadges(badges).map((b) => b.key);

describe('a badge’s rung on its own ladder', () => {
  it.each([
    ['create:models-1', 0],
    ['create:models-25', 2],
    ['create:models-500', 4],
    ['earn:shop-sales-250000', 1],
    ['reach:followers-10000', 4],
  ])('%s is rung %i', (key, rung) => {
    expect(milestoneRung(key)).toBe(rung);
  });

  it.each(['score:spark', 'create:models-7', 'secret:0', 'nothing'])('%s has none', (key) => {
    expect(milestoneRung(key)).toBeNull();
  });
});

// Justin's call (2026-10-10). Launch grants carry no observed date; before this they sorted by
// the backfill run's timestamp and crowded out what creators actually just earned.
describe('the order earned badges show in', () => {
  it('puts dated badges first, newest first', () => {
    expect(
      keys([
        badge('create:models-1', new Date('2026-10-01')),
        badge('create:models-500'),
        badge('reach:followers-100', new Date('2026-10-09')),
      ])
    ).toEqual(['reach:followers-100', 'create:models-1', 'create:models-500']);
  });

  it('orders launch grants tiers highest first, then by metal across tracks, hidden last', () => {
    expect(
      keys([
        badge('create:models-1'),
        badge('secret:0', null, 'secret'),
        badge('reach:downloads-1000000'),
        badge('score:spark'),
        badge('community:crucible-votes-1000'),
        badge('score:supernova'),
        badge('earn:shop-sales-1000000'),
        badge('compete:hidden-feat', null, 'compete'),
      ])
    ).toEqual([
      'score:supernova',
      'score:spark',
      'reach:downloads-1000000',
      'earn:shop-sales-1000000',
      'community:crucible-votes-1000',
      'create:models-1',
      'secret:0',
      'compete:hidden-feat',
    ]);
  });

  // Metal, not the raw number: 500 models is that ladder's diamond, 1,000 downloads only bronze.
  it('ranks by rung on each ladder, not by the size of the threshold', () => {
    expect(
      keys([
        badge('reach:downloads-1000'),
        badge('earn:shop-sales-100000'),
        badge('create:models-500'),
        badge('reach:followers-1000'),
      ])
    ).toEqual([
      'create:models-500',
      'reach:followers-1000',
      'reach:downloads-1000',
      'earn:shop-sales-100000',
    ]);
  });

  it('leaves the list it was given alone', () => {
    const given = [badge('create:models-1'), badge('create:models-500')];
    sortEarnedBadges(given);
    expect(given.map((b) => b.key)).toEqual(['create:models-1', 'create:models-500']);
  });
});
