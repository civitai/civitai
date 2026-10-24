import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as UserService from '~/server/services/user.service';

/**
 * A read that needs a browsing level fills in the viewer's own when it is omitted
 * (`model.getAll`, via `resolveRequestBrowsingLevels`). This pins that the fill-in
 * stays out of the middleware every procedure shares, which runs on mutations too.
 *
 * `user.updateContentSettings` saves any `browsingLevel` it is given, and the site
 * sends only the settings that changed. A level filled in upstream would overwrite
 * the viewer's saved level on every unrelated settings change, so a call without one
 * must reach the service without one.
 *
 * Driven through the real router with `createCaller`, as a signed-in viewer on a
 * domain that allows mature content (where the domain cap fills in nothing).
 */

const { mockUpdateContentSettings } = vi.hoisted(() => ({
  mockUpdateContentSettings: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  updateContentSettings: mockUpdateContentSettings,
}));

import { userRouter } from '~/server/routers/user.router';

const USER_ID = 31;

const user = {
  id: USER_ID,
  isModerator: false,
  tier: 'free',
  username: 'ada',
  muted: false,
  onboarding: 0xff,
  showNsfw: true,
  // PG|R|X: equal to none of the shared flag constants.
  browsingLevel: 13,
};

const caller = () =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true },
    track: undefined,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateContentSettings.mockResolvedValue(undefined);
});

describe('user.updateContentSettings, signed in where mature content is allowed', () => {
  it('reaches the service without a browsingLevel when the caller sent none', async () => {
    await caller().updateContentSettings({ blurNsfw: false });

    expect(mockUpdateContentSettings).toHaveBeenCalledTimes(1);
    const [args] = mockUpdateContentSettings.mock.calls[0];
    expect(args.blurNsfw).toBe(false);
    expect(args.browsingLevel).toBeUndefined();
  });

  // Positive control: the assertion above can see a level when one is sent.
  it('reaches the service with the browsingLevel the caller sent', async () => {
    await caller().updateContentSettings({ browsingLevel: 4 });

    expect(mockUpdateContentSettings.mock.calls[0][0].browsingLevel).toBe(4);
  });
});
