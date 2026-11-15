import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getModelPerformance, getFirstVersionDate } = vi.hoisted(() => ({
  getModelPerformance: vi.fn(),
  getFirstVersionDate: vi.fn(),
}));
vi.mock('$lib/server/models-earnings', () => ({ getModelPerformance, getFirstVersionDate }));

const { load } = await import('./+page.server');

const jar = new Map<string, string>();
const run = () =>
  load({
    locals: { user: { id: 7 } },
    cookies: { get: (k: string) => jar.get(k) },
  } as unknown as Parameters<typeof load>[0]) as Promise<{ modelPerformance: unknown }>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
  jar.clear();
  getModelPerformance.mockReset().mockResolvedValue([]);
  getFirstVersionDate.mockReset().mockResolvedValue('2023-02-14');
});
afterEach(() => vi.useRealTimers());

describe('/analytics/models all-time period', () => {
  it("reads the owner's whole history from their first version, with an empty comparison window", async () => {
    jar.set('cs-model-period', 'all');
    await run();
    expect(getFirstVersionDate).toHaveBeenCalledWith({ userId: 7 });
    expect(getModelPerformance).toHaveBeenCalledWith({
      userId: 7,
      from: '2023-02-14',
      to: '2026-11-13',
      compareFrom: '2023-02-14',
      compareTo: '2023-02-13',
    });
  });

  it('returns no rows, and reads nothing from ClickHouse, for a creator with no versions', async () => {
    jar.set('cs-model-period', 'all');
    getFirstVersionDate.mockResolvedValue(null);
    const out = await run();
    expect(out.modelPerformance).toEqual([]);
    expect(getModelPerformance).not.toHaveBeenCalled();
  });

  it('defaults to the selected month when the cookie is absent', async () => {
    await run();
    expect(getFirstVersionDate).not.toHaveBeenCalled();
    expect(getModelPerformance).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, from: '2026-11-01', to: '2026-11-30' })
    );
  });
});
