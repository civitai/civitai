import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Who may read the paused-notice state and raise their own daily app limit. Both are the
 * viewer's own session only (`blockApiKeys`): an app or script holding an API key, even a
 * full-scope one, must not be able to raise a user's spend ceiling. The service is replaced, so
 * these pin the procedure gate and the subject the service is handed.
 */

const { svc } = vi.hoisted(() => ({
  svc: { getMyAppBuzzCap: vi.fn(), optInAppBuzzToday: vi.fn() },
}));
vi.mock('~/server/services/blocks/app-buzz-usage.service', () => svc);

import { userRouter } from '~/server/routers/user.router';

const REQ = { headers: {}, socket: {} };
const USER = { id: 42, tier: 'free', username: 'u', muted: false, onboarding: 0xff };

const caller = (opts: { user?: object; apiKeyId?: number | null; tokenScope?: number }) =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user: opts.user,
    apiKeyId: opts.apiKeyId ?? null,
    tokenScope: opts.tokenScope ?? TokenScope.Full,
    req: REQ,
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: { userActivity: vi.fn() },
  } as never);

const PROCS = [
  ['getAppBuzzCap', (c: ReturnType<typeof caller>) => c.getAppBuzzCap(), svc.getMyAppBuzzCap],
  [
    'optInAppBuzzToday',
    (c: ReturnType<typeof caller>) => c.optInAppBuzzToday(),
    svc.optInAppBuzzToday,
  ],
] as const;

beforeEach(() => {
  svc.getMyAppBuzzCap.mockReset().mockResolvedValue(null);
  svc.optInAppBuzzToday.mockReset().mockResolvedValue({ paused: false });
});

describe.each(PROCS)('user.%s', (_name, call, service) => {
  it('refuses a caller with no session', async () => {
    await expect(call(caller({}))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service).not.toHaveBeenCalled();
  });

  it('refuses an API key, even a full-scope one', async () => {
    await expect(
      call(caller({ user: USER, apiKeyId: 5, tokenScope: TokenScope.Full }))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(service).not.toHaveBeenCalled();
  });

  it("reaches the service with the session's own user", async () => {
    await call(caller({ user: USER }));
    expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });
});
