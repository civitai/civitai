import { describe, expect, it, vi } from 'vitest';
import { existingTopics, subscribeExisting } from '../vector-sync/domain/consumer';
import { vectorSyncMetrics } from '../vector-sync/metrics';

const CONFIGURED = ['postgres.Article', 'postgres.Model3D', 'postgres.TagsOnModel3D'];

describe('existingTopics', () => {
  it('leaves out a configured topic Kafka does not have, keeping the rest', async () => {
    const result = await existingTopics(
      async () => ['postgres.Article', 'postgres.TagsOnModel3D', 'postgres.Unrelated'],
      CONFIGURED
    );
    expect(result).toEqual({
      present: ['postgres.Article', 'postgres.TagsOnModel3D'],
      missing: ['postgres.Model3D'],
    });
  });

  it('keeps every topic when all exist', async () => {
    expect(await existingTopics(async () => CONFIGURED, CONFIGURED)).toEqual({
      present: CONFIGURED,
      missing: [],
    });
  });

  it('propagates a failed topic listing rather than subscribing to nothing', async () => {
    await expect(
      existingTopics(() => Promise.reject(new Error('broker down')), CONFIGURED)
    ).rejects.toThrow('broker down');
  });
});

describe('subscribeExisting', () => {
  const gauge = async () =>
    Object.fromEntries(
      (await vectorSyncMetrics.missingTopics.get()).values.map((v) => [v.labels.topic, v.value])
    );

  it('subscribes only to the topics Kafka has and gauges the missing one', async () => {
    const subscribe = vi.fn(async () => undefined);
    const topics = await subscribeExisting(
      { subscribe },
      async () => ['postgres.Article', 'postgres.TagsOnModel3D'],
      CONFIGURED,
      'test'
    );
    expect(topics).toEqual(['postgres.Article', 'postgres.TagsOnModel3D']);
    expect(subscribe).toHaveBeenCalledWith({
      topics: ['postgres.Article', 'postgres.TagsOnModel3D'],
      fromBeginning: false,
    });
    expect(await gauge()).toMatchObject({
      'postgres.Article': 0,
      'postgres.Model3D': 1,
      'postgres.TagsOnModel3D': 0,
    });
  });

  it('throws without subscribing when none of the topics exist', async () => {
    const subscribe = vi.fn(async () => undefined);
    await expect(
      subscribeExisting({ subscribe }, async () => ['postgres.Unrelated'], CONFIGURED, 'test')
    ).rejects.toThrow('none of its topics exist');
    expect(subscribe).not.toHaveBeenCalled();
  });
});
