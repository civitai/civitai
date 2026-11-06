import { describe, expect, it, vi } from 'vitest';
import type * as SiteAlertService from '~/server/services/site-alert.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

vi.mock('~/server/services/site-alert.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAlertService>()),
  postSiteAlert: vi.fn(async () => ({ id: 1 })),
  endSiteAlert: vi.fn(async () => ({ id: 1 })),
  listSiteAlerts: vi.fn(async () => []),
  getActiveSiteAlerts: vi.fn(),
}));

const { getActiveSiteAlerts } = await import('~/server/services/site-alert.service');
const { siteAlertRouter } = await import('~/server/routers/site-alert.router');
const { createCallerFactory } = await import('~/server/trpc');

const MODERATOR = {
  id: 31,
  username: 'mod',
  isModerator: true,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  muted: false,
};

const ctx = (cache: Record<string, unknown> = {}, user: Record<string, unknown> = MODERATOR) =>
  ({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    track: { action: vi.fn(async () => undefined) },
    ip: '127.0.0.1',
    cache,
    req: undefined,
    res: undefined,
  } as never);

const call = createCallerFactory(siteAlertRouter);

describe('siteAlert router', () => {
  it('refuses a post over 7 days before it reaches the service', async () => {
    await expect(
      call(ctx()).post({
        severity: 'info',
        title: 'x',
        endsAt: new Date(Date.now() + 8 * 24 * 3_600_000),
      })
    ).rejects.toThrow(/at most 7 days/);
  });

  it('refuses every write to a signed-in user who is not a moderator', async () => {
    const member = { ...MODERATOR, isModerator: false };
    const endsAt = new Date(Date.now() + 3_600_000);
    await expect(
      call(ctx({}, member)).post({ severity: 'info', title: 'x', endsAt })
    ).rejects.toThrow();
    await expect(call(ctx({}, member)).end({ id: 1 })).rejects.toThrow();
    await expect(call(ctx({}, member)).list()).rejects.toThrow();
  });

  // A caller-chosen `v` must never be cached: one ahead of this pod would pin a stale list under
  // the new version's URL.
  it.each([
    ['ahead of this pod', 6, false],
    ['behind this pod', 4, false],
    ['the current version', 5, true],
    ['absent', undefined, true],
  ])('caches a request whose v is %s: %s', async (_, v, cacheable) => {
    vi.mocked(getActiveSiteAlerts).mockResolvedValue({ version: 5, alerts: [] });
    const cache = { canCache: true, edgeTTL: 60, browserTTL: 60, skip: false };
    await call(ctx(cache)).getActive(v === undefined ? {} : { v });
    expect(cache.canCache).toBe(cacheable);
    if (!cacheable) expect([cache.edgeTTL, cache.browserTTL]).toEqual([0, 0]);
  });
});
