import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { loraSectionFor } = await import('../tickets/lora-runs');

const runs = vi.fn();
const models = vi.fn();
const reads = {
  runs: (...a: unknown[]) => runs(...a),
  models: (...a: unknown[]) => models(...a),
} as never;

const run = (id: number, over: Record<string, unknown> = {}) => ({
  modelVersionId: id,
  modelId: id * 10,
  modelName: `Model ${id}`,
  name: `v${id}`,
  baseModel: 'SDXL',
  trainingType: 'Character',
  status: 'InReview',
  numImages: 20,
  sharedDataset: false,
  currentEpoch: 5,
  maxEpochs: 10,
  buzzCost: 1234,
  startedAt: '2026-10-01T00:00:00.000Z',
  submittedAt: '2026-10-01T00:00:00.000Z',
  completedAt: '2026-10-02T00:00:00.000Z',
  engine: 'kohya',
  params: { lr: 1 },
  submitCount: 1,
  history: null,
  ...over,
});

beforeEach(() => {
  runs.mockReset().mockResolvedValue({
    runs: [run(1)],
    truncated: false,
    charges: { count: 3, buzz: 99999, first: null, last: null, unmatched: [], truncated: false },
  });
  models.mockReset().mockResolvedValue({ username: 'alice', blocked: new Set<number>() });
});

describe('loraSectionFor', () => {
  it('lists the runs of the user with what a support agent needs, and the account name for the queue link', async () => {
    const res = await loraSectionFor({ userId: 7 }, reads);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      username: 'alice',
      truncated: false,
      runs: [
        {
          modelVersionId: 1,
          modelId: 10,
          modelName: 'Model 1',
          name: 'v1',
          status: 'InReview',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-02T00:00:00.000Z',
          cannotPublish: false,
        },
      ],
    });
    expect(runs).toHaveBeenCalledWith(7, 10);
    expect(models).toHaveBeenCalledWith(7, [10]);
  });

  it('never puts spend, params or anything beyond the summary in the payload', async () => {
    const res = JSON.stringify(await loraSectionFor({ userId: 7 }, reads));
    for (const leak of ['charges', 'buzz', '1234', '99999', 'params', 'kohya', 'history'])
      expect(res).not.toContain(leak);
  });

  it('marks a run whose model is blocked from publishing, per model', async () => {
    runs.mockResolvedValue({
      runs: [run(1), run(2, { modelId: 10, name: 'v2' }), run(3)],
      truncated: false,
      charges: null,
    });
    models.mockResolvedValue({ username: 'alice', blocked: new Set([10]) });
    const res = await loraSectionFor({ userId: 7 }, reads);
    expect(res.status === 'ok' && res.runs.map((r) => r.cannotPublish)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('passes the cut on', async () => {
    runs.mockResolvedValue({ runs: [run(1)], truncated: true, charges: null });
    expect(await loraSectionFor({ userId: 7 }, reads)).toMatchObject({
      truncated: true,
    });
  });

  it('is unavailable when the runs cannot be read, or the publish state cannot', async () => {
    runs.mockRejectedValue(new Error('db down'));
    expect(await loraSectionFor({ userId: 7 }, reads)).toEqual({
      status: 'unavailable',
      userId: 7,
    });
    runs.mockResolvedValue({ runs: [run(1)], truncated: false, charges: null });
    models.mockRejectedValue(new Error('db down'));
    expect(await loraSectionFor({ userId: 7 }, reads)).toEqual({
      status: 'unavailable',
      userId: 7,
    });
  });

  it('skips the model read for a user with no runs', async () => {
    runs.mockResolvedValue({ runs: [], truncated: false, charges: null });
    expect(await loraSectionFor({ userId: 7 }, reads)).toMatchObject({
      status: 'ok',
      runs: [],
      username: null,
    });
    expect(models).not.toHaveBeenCalled();
  });
});
