import { describe, expect, it, vi } from 'vitest';
import { SESSION_REGISTRY_KEYS } from '@civitai/auth';
import type * as Axiom from '../axiom';

// The sign-in gate reads the shared revocation markers, so a sign-out written by any app ends the session here.
const hashes = vi.hoisted(() => new Map<string, Map<string, string>>());
const store = vi.hoisted(() => ({ down: false }));
const read = async <T>(value: () => T) => {
  if (store.down) throw new Error('connection refused');
  return value();
};
vi.mock('../redis', () => ({
  getSysRedis: () => ({
    hGet: (key: string, field: string) => read(() => hashes.get(key)?.get(field) ?? null),
    get: () => read(() => null),
  }),
}));

const logged = vi.hoisted(() =>
  vi.fn<(event: Record<string, unknown>) => Promise<undefined>>(async () => undefined)
);
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logToAxiom: logged,
}));

const { isRevoked } = await import('../auth');

const claims = { jti: 'child', sid: 'root', sub: '7', signedAt: Date.now() };

describe('isRevoked', () => {
  it('ends a session whose family was signed out elsewhere', async () => {
    hashes.set(SESSION_REGISTRY_KEYS.familyState, new Map([['root', 'invalid']]));
    expect(await isRevoked(claims as never)).toBe(true);
  });

  it('keeps a session whose family is live', async () => {
    hashes.clear();
    expect(await isRevoked(claims as never)).toBe(false);
  });

  it('allows the request and logs a fail-open when the session store is unreachable', async () => {
    store.down = true;
    try {
      expect(await isRevoked(claims as never)).toBe(false);
    } finally {
      store.down = false;
    }
    expect(logged).toHaveBeenCalledTimes(1);
    const event = logged.mock.calls[0][0];
    expect(event).toMatchObject({
      name: 'sysredis-fail-open',
      type: 'warning',
      subtype: 'read-degraded',
      message: 'connection refused',
    });
    expect(JSON.stringify(event)).not.toMatch(/child|root/);
  });
});
