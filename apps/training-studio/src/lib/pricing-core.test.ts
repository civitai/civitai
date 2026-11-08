import { describe, expect, it, vi } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import { cardFromPrice } from '../routes/trainingFlow';

const zimage = cardByType('zimage')!;
const [turbo, base] = zimage.versions;
const QUOTES: Record<string, number> = { [turbo!.air]: 100, [base!.air]: 300 };

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
