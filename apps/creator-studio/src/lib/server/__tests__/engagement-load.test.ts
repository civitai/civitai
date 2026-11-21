import { afterEach, describe, expect, it, vi } from 'vitest';

// The engagement page's load: the Hot rank read must never hold up or take down the list.
const holder = vi.hoisted(() => ({
  hotRanks: (() => Promise.resolve(null)) as () => Promise<unknown>,
}));

vi.mock('$lib/server/engagement', () => ({
  getModelEngagement: async () => [{ modelId: 10 }],
  getHotRanks: () => holder.hotRanks(),
  hotRankAsOf: (day: string | null) => (day ? 'as of last night' : null),
}));
vi.mock('$lib/server/logger', () => ({ getLogger: () => ({ logToAxiom: () => undefined }) }));
vi.mock('$lib/server/table-sort', () => ({ readTableSort: () => null }));

const { load } = await import('../../../routes/(app)/analytics/engagement/+page.server');
const run = () =>
  load({ locals: { user: { id: 1 } }, cookies: {} } as unknown as Parameters<
    typeof load
  >[0]) as Promise<Record<string, unknown>>;

afterEach(() => {
  vi.useRealTimers();
});

describe('engagement page load', () => {
  it('serves the list with no ranks when the rank read fails', async () => {
    holder.hotRanks = () => Promise.reject(new Error('clickhouse down'));

    expect(await run()).toMatchObject({ engagement: [{ modelId: 10 }], hotRanks: null });
  });

  it('stops waiting for a stalled rank read after 3 seconds', async () => {
    vi.useFakeTimers();
    holder.hotRanks = () => new Promise(() => undefined);

    const result = run();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await result).toMatchObject({ engagement: [{ modelId: 10 }], hotRanks: null });
  });
});
