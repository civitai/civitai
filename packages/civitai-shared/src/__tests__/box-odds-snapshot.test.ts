import { describe, expect, it } from 'vitest';
import {
  boxOddsSnapshotSchema,
  diffBoxSnapshots,
  snapshotOfLiveBox,
  snapshotsMatch,
} from '../box-odds-snapshot';

const TIERS = [
  { id: 1, key: 'common', name: 'Common', weight: 80, sortOrder: 0 },
  { id: 2, key: 'rare', name: 'Rare', weight: 20, sortOrder: 1 },
];
const CONTENTS = [
  { tierId: 1, cosmeticId: 10 },
  { tierId: 1, cosmeticId: 11 },
  { tierId: 2, cosmeticId: 20 },
];

describe('boxOddsSnapshotSchema', () => {
  // Every snapshot written before creator boxes has neither field; the odds page parses them all.
  it('parses a platform snapshot with no price or values', () => {
    const legacy = snapshotOfLiveBox(TIERS, CONTENTS);
    expect(boxOddsSnapshotSchema.parse(legacy)).toEqual(legacy);
  });

  // zod drops keys it doesn't know, so a field missing from the schema would vanish on read.
  it('keeps a creator box price and per-content values', () => {
    const parsed = boxOddsSnapshotSchema.parse({
      ...snapshotOfLiveBox(TIERS, CONTENTS),
      price: 700,
      contents: [{ tier: 'common', cosmeticId: 10, value: 500 }],
    });
    expect(parsed.price).toBe(700);
    expect(parsed.contents[0].value).toBe(500);
  });
});

describe('snapshotsMatch: a price edit is not an odds change', () => {
  // Decision (creator mystery packs design §11): the odds page compares the live box with the
  // current version's snapshot and says the history is missing a change when they differ. The live
  // box carries no price or values, so counting them here would show that notice on every creator
  // box. Keep them out unless the live side starts recording them too.
  it('matches a snapshot that adds a price and values to the same odds', () => {
    const live = snapshotOfLiveBox(TIERS, CONTENTS);
    const stored = {
      ...live,
      price: 700,
      contents: live.contents.map((content) => ({ ...content, value: 500 })),
    };
    expect(snapshotsMatch(live, stored)).toBe(true);
  });

  it('still counts a moved item as a change when the snapshot has a price', () => {
    const live = snapshotOfLiveBox(TIERS, CONTENTS);
    const stored = {
      ...live,
      price: 700,
      contents: live.contents.map((content) =>
        content.cosmeticId === 11 ? { ...content, tier: 'rare', value: 500 } : content
      ),
    };
    expect(snapshotsMatch(live, stored)).toBe(false);
  });
});

describe('diffBoxSnapshots', () => {
  const live = {
    tiers: [
      { key: 'common', name: 'Common', weight: 8075 },
      { key: 'rare', name: 'Rare', weight: 1925 },
    ],
    contents: [
      { tier: 'common', cosmeticId: 1 },
      { tier: 'common', cosmeticId: 2 },
      { tier: 'rare', cosmeticId: 3 },
    ],
    price: 600,
  };

  it('reports nothing for an unchanged box', () => {
    expect(diffBoxSnapshots(live, live)).toEqual({
      added: [],
      removed: [],
      moved: [],
      tiers: [],
      price: null,
    });
  });

  it('names each added, removed and moved item, every weight change and the price change', () => {
    const next = {
      tiers: [
        { key: 'common', name: 'Common', weight: 7000 },
        { key: 'rare', name: 'Rare', weight: 2500 },
        { key: 'legendary', name: 'Legendary', weight: 500 },
      ],
      contents: [
        { tier: 'common', cosmeticId: 1 },
        { tier: 'legendary', cosmeticId: 2 },
        { tier: 'rare', cosmeticId: 4 },
      ],
      price: 550,
    };
    expect(diffBoxSnapshots(live, next)).toEqual({
      added: [{ tier: 'rare', cosmeticId: 4 }],
      removed: [{ tier: 'rare', cosmeticId: 3 }],
      moved: [{ cosmeticId: 2, from: 'common', to: 'legendary' }],
      tiers: [
        { key: 'common', name: 'Common', before: 8075, after: 7000 },
        { key: 'rare', name: 'Rare', before: 1925, after: 2500 },
        { key: 'legendary', name: 'Legendary', before: null, after: 500 },
      ],
      price: { before: 600, after: 550 },
    });
  });

  it('reports a tier the edit drops, and refused weights as null', () => {
    const next = {
      tiers: [{ key: 'common', name: 'Common', weight: null }],
      contents: live.contents.map((c) => ({ ...c, tier: 'common' })),
      price: 600,
    };
    expect(diffBoxSnapshots(live, next).tiers).toEqual([
      { key: 'common', name: 'Common', before: 8075, after: null },
      { key: 'rare', name: 'Rare', before: 1925, after: null },
    ]);
  });
});
