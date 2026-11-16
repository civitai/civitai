import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { Sleep } from '~/server/services/notice-ledger.service';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  countNoticeSent,
  removeNoticeSent,
  sendLedgeredNotice,
} from '~/server/services/notice-ledger.service';

describe('sendLedgeredNotice pace', () => {
  const sleep = vi.fn<Sleep>(async () => undefined);
  beforeEach(() => {
    sleep.mockClear();
    // A frozen clock: every wait is then the full gap to the send's reserved slot.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    redisMock.sysRedis.hSetNX.mockResolvedValue(true);
    redisMock.sysRedis.expireAt.mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (batchSize: number) =>
    sendLedgeredNotice({
      ledgerKey: REDIS_SYS_KEYS.NOTICES.NC_OLDER_SENT,
      expiresAt: new Date('2027-03-01T00:00:00Z'),
      logName: 'test-notice',
      pending: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 50,
      batchSize,
      minIntervalMs: 500,
      sleep,
      send: async () => undefined,
    });

  it('starts sends at least `minIntervalMs` apart, one after another', async () => {
    expect(await run(1)).toMatchObject({ sent: 3 });
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  it('waits before claiming, so a run that dies mid-wait records no one it did not send', async () => {
    const before = redisMock.sysRedis.hSetNX.mock.calls.length;
    const claimedAtWait: number[] = [];
    sleep.mockImplementation(async () => {
      claimedAtWait.push(redisMock.sysRedis.hSetNX.mock.calls.length - before);
    });
    await run(1);
    expect(claimedAtWait).toEqual([1, 2]);
  });

  it('spaces the sends inside a parallel batch too', async () => {
    expect(await run(3)).toMatchObject({ sent: 3 });
    expect(sleep.mock.calls.map(([ms]) => ms).sort((a, b) => a - b)).toEqual([500, 1_000]);
  });
});

describe('the sent ledger', () => {
  const KEY = REDIS_SYS_KEYS.NOTICES.KLEIN9B_SENT;

  it('counts the users recorded as sent in that notice’s ledger', async () => {
    redisMock.sysRedis.hLen.mockResolvedValue(7);
    expect(await countNoticeSent(KEY)).toBe(7);
    expect(redisMock.sysRedis.hLen).toHaveBeenCalledWith(KEY);
  });

  it('forgets one user in that notice’s ledger', async () => {
    redisMock.sysRedis.hDel.mockResolvedValue(1);
    expect(await removeNoticeSent(KEY, 42)).toBe(1);
    expect(redisMock.sysRedis.hDel).toHaveBeenCalledWith(KEY, '42');
  });
});
