import { describe, expect, it, vi } from 'vitest';
import { checkFixedWindow } from '~/server/utils/fixed-window-rate-limit';

/** A fake counter store: one key's count and TTL (-1 = no expiry, as Redis reports it). */
function fakeClient(initial: { count?: number; ttl?: number } = {}) {
  const state = { count: initial.count ?? 0, ttl: initial.ttl ?? -2 };
  return {
    state,
    client: {
      incrBy: vi.fn(async (_k: never, by: number) => (state.count += by)),
      expire: vi.fn(async (_k: never, seconds: number) => {
        state.ttl = seconds;
        return true;
      }),
      ttl: vi.fn(async () => state.ttl),
    } as never,
  };
}

const check = (client: never, failOpen = false) =>
  checkFixedWindow('k', 3, 60, { failOpen, client });

describe('checkFixedWindow', () => {
  it('allows up to the max, then refuses with a retry-after', async () => {
    const { client } = fakeClient();
    for (let i = 0; i < 3; i++) await expect(check(client)).resolves.toEqual({ allowed: true });
    await expect(check(client)).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('re-asserts a lost TTL so the key cannot lock the user out forever', async () => {
    const { client, state } = fakeClient({ count: 5, ttl: -1 });
    await check(client);
    expect(state.ttl).toBe(60);
  });

  it.each([
    [false, { allowed: false, retryAfterSeconds: 60 }],
    [true, { allowed: true }],
  ])('on a Redis error with failOpen=%s answers %j', async (failOpen, expected) => {
    const client = {
      incrBy: vi.fn(async () => {
        throw new Error('down');
      }),
    } as never;
    await expect(check(client, failOpen)).resolves.toEqual(expected);
  });
});
