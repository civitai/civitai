import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { Sleep } from '~/server/services/notice-ledger.service';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import {
  countNoticeSent,
  isThrottlingError,
  removeNoticeSent,
  sendLedgeredNotice,
  withThrottleRetry,
} from '~/server/services/notice-ledger.service';

const throttle = () =>
  Object.assign(new Error('454 Throttling failure: Maximum sending rate exceeded'), {
    responseCode: 454,
  });

describe('isThrottlingError', () => {
  it('knows an SES throttle by its SMTP code or its message, and nothing else', () => {
    expect(isThrottlingError(throttle())).toBe(true);
    expect(isThrottlingError(new Error('Throttling failure: Maximum sending rate exceeded'))).toBe(
      true
    );
    expect(isThrottlingError(Object.assign(new Error('x'), { responseCode: 454 }))).toBe(true);
    expect(isThrottlingError(new Error('Email(s) (a@b.c) could not be sent'))).toBe(false);
    expect(isThrottlingError(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(false);
  });
});

describe('withThrottleRetry', () => {
  const sleep = vi.fn<Sleep>(async () => undefined);
  beforeEach(() => sleep.mockClear());

  it('retries a throttled call after each delay until it succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(throttle()).mockResolvedValueOnce('ok');
    await expect(withThrottleRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[2_000]]);
  });

  it('gives up with the throttle after the last delay', async () => {
    const fn = vi.fn().mockRejectedValue(throttle());
    await expect(withThrottleRetry(fn, { sleep })).rejects.toThrow('Throttling');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2_000], [5_000]]);
  });

  it('does not retry any other failure', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rejected'));
    await expect(withThrottleRetry(fn, { sleep })).rejects.toThrow('rejected');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

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
