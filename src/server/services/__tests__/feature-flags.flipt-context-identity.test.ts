import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * The Flipt client builds a context's eval-cache key once per FROZEN context object and reuses it
 * (`@civitai/flipt`'s `client.context-key-memo.test.ts`). That only pays off if the full
 * feature-flag compute hands it one frozen object, for one entity id, for every flag it evaluates
 * — the seam this file pins.
 */

const { evals } = vi.hoisted(() => ({
  evals: [] as { flag: string; entityId: string; context: Record<string, string> }[],
}));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (flag: string, entityId: string, context: Record<string, string>) => {
    evals.push({ flag, entityId, context });
    return null;
  },
  ensureFliptInitialized: async () => undefined,
  FLIPT_FEATURE_FLAGS: {},
}));

import { buildFliptContext, getFeatureFlagsAsync } from '../feature-flags.service';

const req = () =>
  ({ headers: { host: 'civitai.com', 'cf-ipcountry': 'US' } } as unknown as NextApiRequest);
const user = {
  id: 4242,
  username: 'u',
  isModerator: false,
  tier: 'gold',
  permissions: [],
  onboarding: 0,
} as unknown as SessionUser;

describe('the full feature-flag compute and its Flipt context', () => {
  it.each([
    ['a signed-in user', user, '4242'],
    ['an anonymous visitor', undefined, 'anonymous'],
  ])('for %s, passes ONE frozen context to every evaluation', async (_n, u, id) => {
    evals.length = 0;
    await getFeatureFlagsAsync({ user: u, req: req() });

    expect(evals.length).toBeGreaterThan(20);
    const [first] = evals;
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(first.context).toEqual(buildFliptContext(u));
    for (const e of evals) {
      expect(e.context).toBe(first.context);
      expect(e.entityId).toBe(id);
    }
  });
});
