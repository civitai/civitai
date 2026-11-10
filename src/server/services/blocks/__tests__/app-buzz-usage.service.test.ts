import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { UserAppCaps } from '~/server/services/blocks/user-app-caps.service';

const { appsOn, promptOn, resolveCaps } = vi.hoisted(() => ({
  appsOn: vi.fn(),
  promptOn: vi.fn(),
  resolveCaps: vi.fn(),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: appsOn,
  isAppLimitsUpgradePromptEnabled: promptOn,
}));
vi.mock('~/server/services/blocks/user-app-caps.service', () => ({
  resolveUserAppCaps: resolveCaps,
}));

import {
  getMyAppBuzzCap,
  getMyAppBuzzToday,
  optInAppBuzzToday,
} from '~/server/services/blocks/app-buzz-usage.service';

const USER = { id: 42 } as never;
const counterReads = (value: string | null) =>
  redisMock.sysRedis.get.mockImplementation(async () => value);

const TODAY: UserAppCaps = {
  buzzPerDay: 50_000,
  planBuzzPerDay: 50_000,
  optInBuzzPerDay: 50_000,
  optedIn: false,
  docBytes: 2_097_152,
  docCount: 1_000,
};
/** A plan cap with a higher ceiling to opt in to; distinct from every other number here. */
const CAN_OPT_IN: UserAppCaps = {
  ...TODAY,
  planBuzzPerDay: 40_000,
  buzzPerDay: 40_000,
  optInBuzzPerDay: 65_000,
};

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-09T21:00:00Z'), toFake: ['Date'] });
  appsOn.mockReset().mockResolvedValue(true);
  promptOn.mockReset().mockResolvedValue(true);
  resolveCaps.mockReset().mockResolvedValue(TODAY);
  redisMock.sysRedis.get.mockReset();
  redisMock.sysRedis.set.mockReset();
});

describe('getMyAppBuzzToday', () => {
  it('gives no row where apps are off, without reading the counter', async () => {
    appsOn.mockResolvedValue(false);
    counterReads('100');
    expect(await getMyAppBuzzToday(USER)).toBeNull();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });

  it('shows 0 used, not a negative, when a refund left the counter below zero', async () => {
    counterReads('-200');
    const row = await getMyAppBuzzToday(USER);
    expect(row).toMatchObject({ used: 0, remaining: 50_000, nextAt: null });
  });

  it('at the cap, nothing remains and it frees up at the next UTC midnight', async () => {
    counterReads('50300');
    const row = await getMyAppBuzzToday(USER);
    expect(row).toMatchObject({
      used: 50_300,
      remaining: 0,
      nextAt: '2026-11-10T00:00:00.000Z',
      resetAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it("the row's limit is the resolver's cap for this user", async () => {
    resolveCaps.mockResolvedValue({ ...TODAY, buzzPerDay: 61_234 });
    counterReads('1000');
    expect(await getMyAppBuzzToday(USER)).toMatchObject({ limit: 61_234, remaining: 60_234 });
    expect(resolveCaps).toHaveBeenCalledWith(42);
  });
});

describe('getMyAppBuzzCap (the paused notice)', () => {
  it('is null with the upgrade-prompt flag off, and reads nothing', async () => {
    promptOn.mockResolvedValue(false);
    expect(await getMyAppBuzzCap(USER)).toBeNull();
    expect(resolveCaps).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalled();
  });

  it('below the plan cap: not paused', async () => {
    resolveCaps.mockResolvedValue(CAN_OPT_IN);
    counterReads('39999');
    expect(await getMyAppBuzzCap(USER)).toMatchObject({ paused: false, used: 39_999 });
  });

  it('at the plan cap: paused, with the opt-in offered and the reset at UTC midnight', async () => {
    resolveCaps.mockResolvedValue(CAN_OPT_IN);
    counterReads('40000');
    expect(await getMyAppBuzzCap(USER)).toEqual({
      used: 40_000,
      limit: 40_000,
      planLimit: 40_000,
      optInLimit: 65_000,
      optedIn: false,
      paused: true,
      canOptIn: true,
      resetAt: '2026-11-10T00:00:00.000Z',
    });
  });

  it('today (no higher ceiling): paused at 50,000 with an upgrade only, no opt-in', async () => {
    counterReads('50000');
    expect(await getMyAppBuzzCap(USER)).toMatchObject({ paused: true, canOptIn: false });
  });

  it('opted in: the cap shown is the raised one, and the opt-in is not offered again', async () => {
    resolveCaps.mockResolvedValue({ ...CAN_OPT_IN, optedIn: true, buzzPerDay: 65_000 });
    counterReads('40000');
    expect(await getMyAppBuzzCap(USER)).toMatchObject({
      limit: 65_000,
      paused: false,
      canOptIn: false,
      optedIn: true,
    });
  });
});

describe('optInAppBuzzToday', () => {
  it('is refused with the flag off, and records nothing', async () => {
    promptOn.mockResolvedValue(false);
    await expect(optInAppBuzzToday(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  it('is refused where there is nothing higher to continue to (today), and records nothing', async () => {
    await expect(optInAppBuzzToday(USER)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });

  // The opt-in is one per-viewer record for the UTC day. It names no app and no other user, and
  // it moves no Buzz: so an app owner is never charged for it.
  it("records exactly one key, the viewer's own, for today, with a TTL past the day", async () => {
    resolveCaps.mockResolvedValue(CAN_OPT_IN);
    counterReads('40000');
    await optInAppBuzzToday(USER);
    expect(redisMock.sysRedis.set.mock.calls).toEqual([
      ['system:blocks:buzz-opt-in:42:2026-11-09', '1', { EX: 90_000 }],
    ]);
  });
});
