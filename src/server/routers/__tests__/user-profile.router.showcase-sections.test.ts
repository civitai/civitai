import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserProfileController from '~/server/controllers/user-profile.controller';

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
});

const { handler } = vi.hoisted(() => ({ handler: vi.fn(async () => []) }));

vi.mock('~/server/controllers/user-profile.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileController>()),
  setShowcaseSectionsHandler: handler,
}));

import { OnboardingComplete } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
const { userProfileRouter } = await import('~/server/routers/user-profile.router');

const ctxFor = (user: Record<string, unknown>) =>
  ({
    user: { onboarding: OnboardingComplete, ...user },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: { host: 'civitai.com' } },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);

// `profileShowcases` is `availability: ['mod']` until Flipt opens it to testers.
const flagOff = () => userProfileRouter.createCaller(ctxFor({ id: 41, username: 'creator' }));
const flagOn = () =>
  userProfileRouter.createCaller(ctxFor({ id: 42, username: 'mod', isModerator: true }));

const section = (overrides: Record<string, unknown> = {}) => ({
  id: 'abc123',
  type: 'Model' as const,
  title: 'Favourites',
  items: [1, 2],
  ...overrides,
});

beforeEach(() => handler.mockClear());

describe('userProfile.setShowcaseSections', () => {
  it('is refused with the flag off', async () => {
    await expect(flagOff().setShowcaseSections({ sections: [section()] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reaches the handler with the flag on', async () => {
    await flagOn().setShowcaseSections({ sections: [section()] });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an 11th section',
      { sections: Array.from({ length: 11 }, (_, i) => section({ id: `s${i}` })) },
    ],
    [
      'a 33rd item',
      { sections: [section({ items: Array.from({ length: 33 }, (_, i) => i + 1) })] },
    ],
    [
      'a javascript: link',
      { sections: [section({ button: { label: 'Go', url: 'javascript:alert(1)' } })] },
    ],
    ['a 61-character title', { sections: [section({ title: 'x'.repeat(61) })] }],
    [
      'a 31-character button label',
      { sections: [section({ button: { label: 'x'.repeat(31), url: '/models' } })] },
    ],
    ['an unsupported type', { sections: [section({ type: 'User' })] }],
  ])('refuses %s before the handler runs', async (_name, input) => {
    await expect(flagOn().setShowcaseSections(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
