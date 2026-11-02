import { describe, expect, it, vi } from 'vitest';
import { memorySkipStore, recordSkip, redisSkipStore, skippedFor, type SkipStore } from './skips';

describe('skippedFor', () => {
  it('groups what a player skipped by kind', async () => {
    const store = memorySkipStore();
    await recordSkip(store, 7, { kind: 'queue', id: 3 }, new Date(1));
    await recordSkip(store, 7, { kind: 'hidden', id: 9 }, new Date(2));
    await recordSkip(store, 7, { kind: 'yesno', id: 5 }, new Date(3));
    await recordSkip(store, 8, { kind: 'queue', id: 4 }, new Date(4));

    expect(await skippedFor(store, 7)).toEqual({ queue: [3], hidden: [9], yesno: [5] });
  });

  it('serves as if nothing was skipped when the store is down', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const down: SkipStore = {
      add: async () => {
        throw new Error('down');
      },
      list: async () => {
        throw new Error('down');
      },
    };

    expect(await skippedFor(down, 7)).toEqual({ queue: [], hidden: [], yesno: [] });
    await expect(recordSkip(down, 7, { kind: 'queue', id: 1 }, new Date())).resolves.toBe(false);
    expect(log).toHaveBeenCalled();
  });
});

describe('redisSkipStore', () => {
  it('writes and reads one sorted set per player', async () => {
    const eval_ = vi.fn(async (_script: string, _options: unknown) => ['q:3', 'h:9']);
    const store = redisSkipStore(() => ({ eval: eval_ }));

    await store.add(7, { kind: 'queue', id: 3 }, new Date(5));
    const listed = await store.list(7);

    const [, add] = eval_.mock.calls[0] as [string, { keys: string[]; arguments: string[] }];
    expect(add.keys).toHaveLength(1);
    expect(add.keys[0]).toContain('7');
    expect(add.arguments).toContain('q:3');
    expect(listed).toEqual([
      { kind: 'queue', id: 3 },
      { kind: 'hidden', id: 9 },
    ]);
  });
});
