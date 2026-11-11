import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { appsOn } = vi.hoisted(() => ({ appsOn: vi.fn() }));
vi.mock('~/server/services/app-blocks-flag', () => ({ isAppBlocksEnabled: appsOn }));

import { getMyAppBuzzToday } from '~/server/services/blocks/app-buzz-usage.service';
import { BLOCK_BUZZ_CAP_PER_DAY } from '~/shared/constants/block-scope.constants';

const USER = { id: 42 } as never;
const counterReads = (value: string | null) =>
  redisMock.sysRedis.get.mockImplementation(async () => value);

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-09T21:00:00Z'), toFake: ['Date'] });
  appsOn.mockReset().mockResolvedValue(true);
  redisMock.sysRedis.get.mockReset();
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
    expect(row).toMatchObject({ used: 0, remaining: BLOCK_BUZZ_CAP_PER_DAY, nextAt: null });
  });

  it('at the cap, nothing remains and it frees up at the next UTC midnight', async () => {
    counterReads(String(BLOCK_BUZZ_CAP_PER_DAY + 300));
    const row = await getMyAppBuzzToday(USER);
    expect(row).toMatchObject({
      used: BLOCK_BUZZ_CAP_PER_DAY + 300,
      remaining: 0,
      nextAt: '2026-11-10T00:00:00.000Z',
      resetAt: '2026-11-10T00:00:00.000Z',
    });
  });
});
