import { describe, expect, it, vi } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import { cardFromPrice, selectionFromTotal } from '../routes/trainingFlow';

const zimage = cardByType('zimage')!;
const [turbo, base] = zimage.versions;
const ltx = cardByType('ltx')!;
const ltx20 = ltx.versions.find((v) => v.key === 'ltx2')!;
const QUOTES: Record<string, number> = {
  [turbo!.air]: 100,
  [base!.air]: 300,
  [ltx.versions[0]!.air]: 900,
  [ltx20.air]: 700,
};

vi.mock('./orchestrator-core', () => ({
  trainingWhatIf: vi.fn(
    async (_client: unknown, input: { model: string }) => QUOTES[input.model] ?? 50
  ),
}));

const { computeFromPrices } = await import('./pricing-core');

describe('from prices for version-gated cards', () => {
  it('prices Z-Image from the first version the viewer can pick', async () => {
    const prices = await computeFromPrices({} as never);
    expect(cardFromPrice(prices, 'zimage', new Set(['zimage-turbo-training']))).toBe(100);
    // Base is open to everyone, Turbo is gated: a viewer without Turbo is quoted Base.
    expect(cardFromPrice(prices, 'zimage', new Set())).toBe(300);
  });
});

describe('the selection total', () => {
  it("prices each run by the version it trains, not the card's first version", async () => {
    const prices = await computeFromPrices({} as never);
    const run = (cardType: string, versionKey: string) => ({ id: 1, cardType, versionKey });
    expect(selectionFromTotal(prices, [run('zimage', 'zimagebase')])).toBe(300);
    expect(selectionFromTotal(prices, [run('zimage', 'zimageturbo')])).toBe(100);
    expect(selectionFromTotal(prices, [run('ltx', 'ltx2'), run('zimage', 'zimagebase')])).toBe(
      1000
    );
  });
});
