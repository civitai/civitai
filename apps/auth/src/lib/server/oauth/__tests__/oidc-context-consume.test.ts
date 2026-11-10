import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ stored: undefined as unknown, fail: false }));
vi.mock('$lib/server/redis', () => ({
  getRedis: () => ({
    packed: {
      hGet: async () => {
        if (h.fail) throw new Error('redis down');
        return h.stored;
      },
    },
    hDel: async () => 1,
  }),
}));

const { consumeOidcContext } = await import('../oidc-nonce');

describe('consumeOidcContext', () => {
  it('returns the stored context', async () => {
    h.fail = false;
    h.stored = { deviceId: 'd', impersonatedBy: 100 };
    expect(await consumeOidcContext('code')).toEqual({ deviceId: 'd', impersonatedBy: 100 });
  });

  it('returns null when there is none', async () => {
    h.fail = false;
    h.stored = null;
    expect(await consumeOidcContext('code')).toBeNull();
  });

  it('returns null when it cannot be read', async () => {
    h.fail = true;
    expect(await consumeOidcContext('code')).toBeNull();
  });
});
