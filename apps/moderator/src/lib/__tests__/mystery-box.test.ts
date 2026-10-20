import { describe, expect, it } from 'vitest';
import { previewOdds, type BoxDraft, type RewardInfo } from '../mystery-box';
import { openingStats } from '../mystery-box-openings';

const reward = (id: number, team: string | null, type = 'cosmetic') =>
  [id, { type, team }] as [number, Pick<RewardInfo, 'type' | 'team'>];

const draft = (
  contents: [rewardDefinitionId: number, tierKey: string, enabled?: boolean][],
  weights: [number, number] = [3, 1]
): Pick<BoxDraft, 'name' | 'tiers' | 'contents'> => ({
  name: 'Box',
  tiers: [
    { id: null, key: 'common', name: 'Common', weight: weights[0], color: null },
    { id: null, key: 'rare', name: 'Rare', weight: weights[1], color: null },
  ],
  contents: contents.map(([rewardDefinitionId, tierKey, enabled = true]) => ({
    id: null,
    rewardDefinitionId,
    tierKey,
    enabled,
  })),
});

describe('previewOdds', () => {
  const rewards = new Map([
    reward(1, 'Blue'),
    reward(2, 'Pink'),
    reward(3, 'Blue'),
    reward(5, null),
  ]);

  it("is one team's base odds: its own and teamless rewards, through the draw's rule", () => {
    const odds = previewOdds(
      draft([
        [1, 'common'],
        [2, 'common'],
        [5, 'common'],
        [3, 'rare'],
      ]),
      rewards,
      'Pink'
    )!;
    // Pink has nothing in Rare, so Common takes the whole chance, shared by Pink's cap and the confetti.
    expect(odds.tiers.map((t) => [t.tierId, t.contentIds.length, t.probability])).toEqual([
      [0, 2, 1],
    ]);
    const blue = previewOdds(
      draft([
        [1, 'common'],
        [2, 'common'],
        [5, 'common'],
        [3, 'rare'],
      ]),
      rewards,
      'Blue'
    )!;
    expect(blue.tiers.map((t) => [t.contentIds.length, t.probability])).toEqual([
      [2, 0.75],
      [1, 0.25],
    ]);
  });
});

describe('openingStats', () => {
  const snapshot = {
    tiers: [
      { key: 'common', name: 'Common', weight: 3 },
      { key: 'rare', name: 'Rare', weight: 1 },
    ],
    contents: [],
  };
  const tiers = [
    { id: 10, key: 'common', name: 'Common' },
    { id: 11, key: 'rare', name: 'Rare' },
  ];

  it('expects counts only from opens where every tier was open, at that version’s weights', () => {
    const [version] = openingStats(
      [
        { boxVersion: 2, tierId: 10, eligibleWeight: 4, count: 30 },
        { boxVersion: 2, tierId: 11, eligibleWeight: 4, count: 10 },
        // Common exhausted for these openers: Rare at 100%, not comparable with the base odds.
        { boxVersion: 2, tierId: 11, eligibleWeight: 1, count: 7 },
      ],
      new Map([[2, snapshot]]),
      tiers
    );
    expect(version).toEqual({
      version: 2,
      opens: 47,
      fullBoxOpens: 40,
      tiersChanged: false,
      tiers: [
        {
          tierId: 10,
          key: 'common',
          name: 'Common',
          observed: 30,
          fullBoxObserved: 30,
          fullBoxExpected: 30,
        },
        {
          tierId: 11,
          key: 'rare',
          name: 'Rare',
          observed: 17,
          fullBoxObserved: 10,
          fullBoxExpected: 10,
        },
      ],
    });
  });

  it('compares nothing in a version with draws from a tier since removed', () => {
    // Tier 9 was this version's Rare; it was removed and Rare added back as tier 11.
    const [version] = openingStats(
      [
        { boxVersion: 2, tierId: 10, eligibleWeight: 4, count: 30 },
        { boxVersion: 2, tierId: 9, eligibleWeight: 4, count: 10 },
      ],
      new Map([[2, snapshot]]),
      tiers
    );
    expect(version.tiersChanged).toBe(true);
    expect(version.tiers.map((t) => t.fullBoxExpected)).toEqual([null, null, null]);
  });

  it('lists a tier nobody drew, and compares nothing for a version with no snapshot', () => {
    const stats = openingStats(
      [
        { boxVersion: 3, tierId: 10, eligibleWeight: 4, count: 4 },
        { boxVersion: 1, tierId: 10, eligibleWeight: 4, count: 2 },
      ],
      new Map([[3, snapshot]]),
      tiers
    );
    expect(stats.map((s) => s.version)).toEqual([3, 1]);
    expect(stats[0].tiers.find((t) => t.key === 'rare')).toMatchObject({
      observed: 0,
      fullBoxExpected: 1,
    });
    expect(stats[1]).toMatchObject({ fullBoxOpens: null });
    expect(stats[1].tiers[0].fullBoxExpected).toBeNull();
  });
});
