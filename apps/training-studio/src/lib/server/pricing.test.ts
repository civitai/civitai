import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ entry: null as unknown }));
const trainingWhatIf = vi.hoisted(() => vi.fn(async () => 50));

vi.mock('@civitai/redis', () => ({
  REDIS_SYS_KEYS: { TRAINING: { STUDIO_FROM_PRICES: 'from-prices' } },
}));
vi.mock('./redis', () => ({
  getSysRedis: () => ({
    packed: {
      get: async () => store.entry,
      set: async (_k: string, v: unknown) => {
        store.entry = v;
      },
    },
  }),
}));
vi.mock('./orchestrator', () => ({ orchestratorClient: () => ({}) }));
vi.mock('$lib/orchestrator-core', () => ({ trainingWhatIf }));

const { getFromPrices } = await import('./pricing');
const { fromPriceQuotes } = await import('$lib/pricing-core');

describe('cached from-prices', () => {
  beforeEach(() => {
    trainingWhatIf.mockClear();
    store.entry = null;
  });

  it('refreshes a fresh entry written for a different catalog', async () => {
    store.entry = { prices: { zimage: 100 }, at: Date.now() };
    expect(await getFromPrices('t')).toEqual({ zimage: 100 });
    await vi.waitFor(() => expect(trainingWhatIf).toHaveBeenCalled());
  });

  it('serves a fresh entry for this catalog without recomputing', async () => {
    const catalog = fromPriceQuotes()
      .map((q) => q.key)
      .join(',');
    store.entry = { prices: { zimage: 100 }, at: Date.now(), catalog };
    expect(await getFromPrices('t')).toEqual({ zimage: 100 });
    await new Promise((r) => setTimeout(r, 0));
    expect(trainingWhatIf).not.toHaveBeenCalled();
  });
});
