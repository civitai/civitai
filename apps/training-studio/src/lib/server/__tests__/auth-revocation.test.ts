import { describe, expect, it, vi } from 'vitest';
import { SESSION_REGISTRY_KEYS } from '@civitai/auth';

// The sign-in gate reads the shared revocation markers, so a sign-out written by any app ends the session here.
const hashes = vi.hoisted(() => new Map<string, Map<string, string>>());
vi.mock('../redis', () => ({
  getSysRedis: () => ({
    hGet: async (key: string, field: string) => hashes.get(key)?.get(field) ?? null,
    get: async () => null,
  }),
}));

const { isRevoked } = await import('../auth');

describe('isRevoked', () => {
  it('ends a session whose family was signed out elsewhere', async () => {
    hashes.set(SESSION_REGISTRY_KEYS.familyState, new Map([['root', 'invalid']]));
    const claims = { jti: 'child', sid: 'root', sub: '7', signedAt: Date.now() };
    expect(await isRevoked(claims as never)).toBe(true);
  });

  it('keeps a session whose family is live', async () => {
    hashes.clear();
    const claims = { jti: 'child', sid: 'root', sub: '7', signedAt: Date.now() };
    expect(await isRevoked(claims as never)).toBe(false);
  });
});
