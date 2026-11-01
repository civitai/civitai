import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * The full feature-flag compute evaluates every Flipt-backed flag for one user. It prepares the
 * Flipt context ONCE (so the eval-cache key part that depends on it is built once, not per flag)
 * and hands that same prepared context, with the entity id it was prepared for, to every
 * evaluation — which is what lets the client reuse the key. Same answers either way.
 */

const { evals, prepares } = vi.hoisted(() => ({
  evals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
  prepares: [] as { entityId: string; context: Record<string, string>; out: object }[],
}));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (flag: string, entityId: string, context: Record<string, string>) => {
    evals.push({ flag, entityId, context });
    return flag.length % 2 === 0;
  },
  prepareFliptContext: (entityId: string, context: Record<string, string>) => {
    const out = Object.freeze({ ...context });
    prepares.push({ entityId, context, out });
    return out;
  },
  ensureFliptInitialized: async () => undefined,
  FLIPT_FEATURE_FLAGS: {},
}));

import { buildFliptContext, getFeatureFlagsAsync } from '../feature-flags.service';

const req = { headers: { host: 'civitai.com', 'cf-ipcountry': 'US' } } as unknown as NextApiRequest;
const user = {
  id: 4242,
  username: 'u',
  isModerator: false,
  tier: 'gold',
  permissions: [],
  onboarding: 0,
} as unknown as SessionUser;

describe('the full feature-flag compute and the Flipt context', () => {
  it.each([
    ['a signed-in user', user, '4242'],
    ['an anonymous visitor', undefined, 'anonymous'],
  ])('for %s, prepares the context once and passes it to every evaluation', async (_n, u, id) => {
    evals.length = 0;
    prepares.length = 0;
    await getFeatureFlagsAsync({ user: u, req: { ...req } as NextApiRequest });

    expect(prepares).toHaveLength(1);
    expect(prepares[0].entityId).toBe(id);
    expect(prepares[0].context).toEqual(buildFliptContext(u));
    // Many flags, one prepared object, each evaluated for the entity it was prepared for.
    expect(evals.length).toBeGreaterThan(20);
    for (const e of evals) {
      expect(e.context).toBe(prepares[0].out);
      expect(e.entityId).toBe(id);
    }
  });
});
