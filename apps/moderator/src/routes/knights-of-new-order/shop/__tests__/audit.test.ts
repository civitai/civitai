import { describe, expect, it } from 'vitest';
import { describeChange, groupByDay } from '../audit';

describe('describeChange', () => {
  it('names a lone price change and shows both prices', () => {
    expect(
      describeChange({ action: 'update', changes: { price: { from: 400, to: 450 } } })
    ).toEqual({
      verb: 'changed the price of',
      chips: [{ field: 'price', from: '400', to: '450' }],
    });
  });

  it('reads a flipped switch as on/off and a cleared rank as none', () => {
    const { chips } = describeChange({
      action: 'update',
      changes: { rotating: { from: true, to: false }, minRank: { from: 'Templar', to: null } },
    });
    expect(chips).toEqual([
      { field: 'rotating', from: 'on', to: 'off' },
      { field: 'rank', from: 'Templar', to: 'none' },
    ]);
  });

  it('falls back to "updated" when several fields changed', () => {
    expect(
      describeChange({
        action: 'update',
        changes: { price: { from: 1, to: 2 }, name: { from: 'a', to: 'b' } },
      }).verb
    ).toBe('updated');
  });

  it('lists only what a create set, skipping defaults and the item identity', () => {
    const { verb, chips } = describeChange({
      action: 'create',
      changes: {
        kind: { from: null, to: 'buzz_pack' },
        name: { from: null, to: 'Buzz 50' },
        buzz: { from: null, to: 50 },
        price: { from: null, to: 1000 },
        minRank: { from: null, to: null },
        rotating: { from: null, to: false },
        sortOrder: { from: null, to: 0 },
        active: { from: null, to: true },
      },
    });
    expect(verb).toBe('added');
    expect(chips.map((c) => `${c.field} ${c.to}`)).toEqual(['buzz 50', 'price 1000']);
  });

  it('names the cosmetic on a create instead of its bare id, and falls back to the id when it is gone', () => {
    const changes = { cosmeticId: { from: null, to: 3980 } };
    expect(
      describeChange({
        action: 'create',
        changes,
        cosmeticName: 'Gay Pride',
        cosmeticType: 'Sticker',
      }).chips
    ).toEqual([{ field: 'cosmetic', from: null, to: 'Gay Pride (Sticker)' }]);
    expect(describeChange({ action: 'create', changes }).chips[0].to).toBe('#3980');
  });

  it('has no chips for a retire or a restore', () => {
    for (const [action, verb] of [
      ['retire', 'retired'],
      ['restore', 'restored'],
    ] as const)
      expect(describeChange({ action, changes: { active: { from: true, to: false } } })).toEqual({
        verb,
        chips: [],
      });
  });
});

describe('groupByDay', () => {
  it('groups consecutive rows by UTC day, newest first, splitting at midnight UTC', () => {
    const rows = [
      { id: 3, createdAt: '2026-11-05T00:01:00Z' },
      { id: 2, createdAt: new Date('2026-11-04T23:59:00Z') },
      { id: 1, createdAt: '2026-11-04T01:00:00Z' },
    ];
    expect(groupByDay(rows).map((g) => [g.day, g.rows.map((r) => r.id)])).toEqual([
      ['2026-11-05', [3]],
      ['2026-11-04', [2, 1]],
    ]);
  });
});
