import { beforeEach, describe, expect, it, vi } from 'vitest';

const rating = vi.hoisted(() => ({ on: false }));
const countDatasetMature = vi.hoisted(() => vi.fn());
const warmDatasetRating = vi.hoisted(() => vi.fn());
const allowance = vi.hoisted(() => ({ lookups: 1 }));

// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({ orchestratorClient: () => ({}) }));
vi.mock('$lib/server/dataset-rating', () => ({
  datasetRatingFor: async () =>
    rating.on ? { matureLevel: 1, read: async () => new Map() } : undefined,
  warmDatasetRating: (...args: unknown[]) => warmDatasetRating(...args),
  claimDaily: async () => allowance.lookups,
}));
vi.mock('$lib/train-core', () => ({
  countDatasetMature: (...args: unknown[]) => countDatasetMature(...args),
}));

const { POST } = await import('./+server');

const post = (body: unknown) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x/api/dataset-rating', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof POST>[0]);

beforeEach(() => {
  rating.on = false;
  allowance.lookups = 1;
  countDatasetMature.mockReset();
  warmDatasetRating.mockReset();
});

describe('POST /api/dataset-rating', () => {
  it('off for this user: says so and rates nothing', async () => {
    expect(await (await post({ blobIds: ['a'] })).json()).toEqual({ enabled: false });
    expect(countDatasetMature).not.toHaveBeenCalled();
    expect(warmDatasetRating).not.toHaveBeenCalled();
  });

  it('on: answers the count and starts rating only the readable, unrated blobs', async () => {
    rating.on = true;
    countDatasetMature.mockResolvedValueOnce({
      images: 3,
      mature: 1,
      failed: 0,
      rated: 1,
      unratedKeys: ['b'],
    });
    expect(await (await post({ blobIds: ['a', 'b', 'c'] })).json()).toEqual({
      enabled: true,
      matureCount: 1,
      unrated: 2,
    });
    expect(warmDatasetRating).toHaveBeenCalledWith('token', 1, ['b']);
    expect(countDatasetMature.mock.calls[0]![1]).toEqual(['a', 'b', 'c']);
  });

  it('a blob it could not read: Review keeps its own count, the rest still gets rated', async () => {
    rating.on = true;
    countDatasetMature.mockResolvedValueOnce({
      images: 2,
      mature: 0,
      failed: 1,
      rated: 0,
      unratedKeys: ['a'],
    });
    expect(await (await post({ blobIds: ['a', 'b'] })).json()).toEqual({ enabled: false });
    expect(warmDatasetRating).toHaveBeenCalledWith('token', 1, ['a']);
  });

  it("past today's allowance: off, and nothing is looked up", async () => {
    rating.on = true;
    allowance.lookups = 0;
    expect(await (await post({ blobIds: ['a'] })).json()).toEqual({ enabled: false });
    expect(countDatasetMature).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a list of blob ids', async () => {
    rating.on = true;
    await expect(post({ blobIds: [1] })).rejects.toMatchObject({ status: 400 });
    await expect(post({})).rejects.toMatchObject({ status: 400 });
  });
});
