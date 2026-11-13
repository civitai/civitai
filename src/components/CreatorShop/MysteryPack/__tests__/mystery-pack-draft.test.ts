import { describe, expect, it } from 'vitest';
import { previewMysteryPack } from '../mystery-pack-draft';

// The design's worked example: standard steepness, 10/5/2/1 items valued 500/1,000/3,000/10,000
// (integer weights 8075/1615/258/52): the price may be 500 to 694.
const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
const draft = { steepness: 'standard' as const, tiers: [ids(1, 10), ids(11, 5), ids(16, 2), [18]] };
const values = new Map<number, number>([
  ...ids(1, 10).map((id) => [id, 500] as const),
  ...ids(11, 5).map((id) => [id, 1000] as const),
  ...ids(16, 2).map((id) => [id, 3000] as const),
  [18, 10000] as const,
]);

describe('previewMysteryPack', () => {
  it('bounds the price at 500 to the average the weights give back', () => {
    const preview = previewMysteryPack(draft, values, 600);
    expect(preview.bounds).toMatchObject({ min: 500, max: 694, worst: 500 });
    expect(preview.priceProblem).toBeNull();
    expect(preview.ready).toBe(true);
  });

  it('says why a price over the average is refused', () => {
    const preview = previewMysteryPack(draft, values, 900);
    expect(preview.priceProblem).toMatch(/at most 694, what the average/);
    expect(preview.ready).toBe(false);
  });

  it('names the worst-draw bound when it is the tighter one', () => {
    // 500 cheapest item caps the price at 1,000 though the average is higher.
    const rich = new Map(values);
    for (const id of ids(11, 5)) rich.set(id, 5000);
    for (const id of ids(16, 2)) rich.set(id, 9000);
    rich.set(18, 50000);
    const preview = previewMysteryPack(draft, rich, 5000);
    expect(preview.bounds).toMatchObject({ max: 1000, worst: 500 });
    expect(preview.priceProblem).toBe('The price is at most 1000, 2 times your cheapest item');
  });

  it('says why a price under the floor is refused', () => {
    expect(previewMysteryPack(draft, values, 100).priceProblem).toMatch(/at least 500/);
  });

  it('asks for a price while none is set', () => {
    const preview = previewMysteryPack(draft, values, undefined);
    expect(preview.priceProblem).toBe('Set a price');
    expect(preview.ready).toBe(false);
  });

  it('refuses a rarer tier with more items, naming the tier', () => {
    const preview = previewMysteryPack(
      { steepness: 'standard', tiers: [ids(1, 2), ids(3, 8)] },
      values,
      600
    );
    expect(preview.layoutProblem).toMatch(/more items in Common/);
    expect(preview.odds).toEqual([]);
    expect(preview.ready).toBe(false);
  });

  it('shows the per-tier odds the draw would use, rarest first', () => {
    const { odds } = previewMysteryPack(draft, values, 600);
    expect(odds.map((t) => t.tier.name)).toEqual(['Legendary', 'Rare', 'Uncommon', 'Common']);
    expect(odds[3].probability).toBeCloseTo(0.8075, 4);
    expect(odds[3].itemProbability).toBeCloseTo(0.08075, 5);
  });

  it('has no bounds while an item has no value', () => {
    const missing = new Map(values);
    missing.delete(18);
    const preview = previewMysteryPack(draft, missing, 600);
    expect(preview.bounds).toBeNull();
    expect(preview.ready).toBe(false);
  });
});
