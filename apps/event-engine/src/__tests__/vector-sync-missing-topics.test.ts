import { describe, expect, it } from 'vitest';
import { existingTopics } from '../vector-sync/domain/consumer';

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
