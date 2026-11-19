import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserProfileController from '~/server/controllers/user-profile.controller';

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
});

const { handler, addHandler, addEntityHandler, isAccountMuted } = vi.hoisted(() => ({
  handler: vi.fn(async () => []),
  addHandler: vi.fn(async () => ({ added: true, sections: [] })),
  addEntityHandler: vi.fn(async () => ({})),
  isAccountMuted: vi.fn(async (_userId: number, sessionValue: boolean) => sessionValue),
}));

vi.mock('~/server/services/account-standing.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAccountMuted,
}));

vi.mock('~/server/controllers/user-profile.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof UserProfileController>()),
  setShowcaseSectionsHandler: handler,
  addToShowcaseSectionHandler: addHandler,
  addEntityToShowcaseHandler: addEntityHandler,
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

beforeEach(() => {
  handler.mockClear();
  addHandler.mockClear();
  addEntityHandler.mockClear();
  isAccountMuted.mockClear();
});

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

describe('userProfile.addToShowcaseSection', () => {
  const input = { sectionId: 'abc123', entityType: 'Image' as const, entityId: 7 };

  it('is refused with the flag off', async () => {
    await expect(flagOff().addToShowcaseSection(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(addHandler).not.toHaveBeenCalled();
  });

  it('reaches the handler with the flag on', async () => {
    await flagOn().addToShowcaseSection(input);
    expect(addHandler).toHaveBeenCalledTimes(1);
  });

  it('refuses a type other than Image before the handler runs', async () => {
    await expect(
      flagOn().addToShowcaseSection({ ...input, entityType: 'Model' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(addHandler).not.toHaveBeenCalled();
  });
});

// A session minted before the mute still says `muted: false`; the stored standing decides.
describe('showcase writes from an account muted after its session was issued', () => {
  const mutedSince = () => isAccountMuted.mockResolvedValueOnce(true);

  it.each([
    [
      'addEntityToShowcase',
      () => flagOn().addEntityToShowcase({ entityType: 'Image', entityId: 7 }),
    ],
    ['setShowcaseSections', () => flagOn().setShowcaseSections({ sections: [section()] })],
    [
      'addToShowcaseSection',
      () =>
        flagOn().addToShowcaseSection({ sectionId: 'abc123', entityType: 'Image', entityId: 7 }),
    ],
  ])('%s is refused before its handler runs', async (_name, call) => {
    mutedSince();
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
    expect(addHandler).not.toHaveBeenCalled();
    expect(addEntityHandler).not.toHaveBeenCalled();
  });

  it('addEntityToShowcase reaches its handler for an unmuted account', async () => {
    await flagOn().addEntityToShowcase({ entityType: 'Image', entityId: 7 });
    expect(addEntityHandler).toHaveBeenCalledTimes(1);
  });
});

describe('userProfile.addEntityToShowcase', () => {
  it('refuses an account flagged for email verification, like userProfile.update', async () => {
    const caller = userProfileRouter.createCaller(
      ctxFor({ id: 43, username: 'unverified', meta: { emailVerificationRequired: true } })
    );
    await expect(
      caller.addEntityToShowcase({ entityType: 'Image', entityId: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(addEntityHandler).not.toHaveBeenCalled();
  });
});
