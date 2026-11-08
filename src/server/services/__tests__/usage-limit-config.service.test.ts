import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  getUsageLimitConfig,
  resetUsageLimitConfigCache,
  resolveUsageLimit,
  USAGE_LIMIT_CONFIG_TTL_MS,
  USAGE_LIMIT_FIRST_READ_TIMEOUT_MS,
} from '~/server/services/usage-limit-config.service';
import { defaultUsageLimitConfig } from '~/shared/constants/usage-limits';

const findKeyValue = dbMock.dbRead.keyValue.findUnique;
const row = (limits: Record<string, unknown>) => ({ value: { version: 1, limits } } as never);
const free = { tier: 'free', meta: { scores: { total: 0 } } };
const firingLogs = () =>
  loggingMock.logToAxiom.mock.calls.filter(
    ([entry]) => (entry as { name?: string }).name === 'usage-limits-defaults-firing'
  );

beforeEach(() => {
  resetUsageLimitConfigCache();
  findKeyValue.mockReset();
  loggingMock.logToAxiom.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('getUsageLimitConfig', () => {
  it('serves the code defaults to a cold pod whose store hangs, after the first-read timeout', async () => {
    vi.useFakeTimers();
    findKeyValue.mockReturnValue(new Promise(() => undefined) as never);
    const config = getUsageLimitConfig();
    await vi.advanceTimersByTimeAsync(USAGE_LIMIT_FIRST_READ_TIMEOUT_MS);
    expect(await config).toBe(defaultUsageLimitConfig);
  });

  it('reads the row once per TTL and refreshes in the background after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    findKeyValue.mockResolvedValue(row({ 'posts.daily': { base: 25 } }));
    expect((await resolveUsageLimit('posts.daily', free)).limit).toBe(25);
    await getUsageLimitConfig();
    expect(findKeyValue).toHaveBeenCalledTimes(1);

    let release: (value: unknown) => void = () => undefined;
    findKeyValue.mockReturnValue(new Promise((resolve) => (release = resolve)) as never);
    vi.advanceTimersByTime(USAGE_LIMIT_CONFIG_TTL_MS + 1);
    // Stale while the refresh is in flight, and only one refresh however many callers.
    expect((await resolveUsageLimit('posts.daily', free)).limit).toBe(25);
    expect((await resolveUsageLimit('posts.daily', free)).limit).toBe(25);
    expect(findKeyValue).toHaveBeenCalledTimes(2);

    release(row({ 'posts.daily': { base: 30 } }));
    await vi.waitFor(async () =>
      expect((await resolveUsageLimit('posts.daily', free)).limit).toBe(30)
    );
  });

  it('keeps the last good config when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    findKeyValue.mockResolvedValue(row({ 'posts.daily': { base: 25 } }));
    await getUsageLimitConfig();
    findKeyValue.mockRejectedValue(new Error('db down'));
    vi.advanceTimersByTime(USAGE_LIMIT_CONFIG_TTL_MS + 1);
    await getUsageLimitConfig();
    await vi.waitFor(() => expect(findKeyValue).toHaveBeenCalledTimes(2));
    expect((await resolveUsageLimit('posts.daily', free)).limit).toBe(25);
  });

  it('logs a refused override once per distinct failure, not once per refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const readFresh = async (reads: number) => {
      vi.advanceTimersByTime(USAGE_LIMIT_CONFIG_TTL_MS + 1);
      await getUsageLimitConfig();
      await vi.waitFor(() => expect(findKeyValue).toHaveBeenCalledTimes(reads));
    };
    findKeyValue.mockResolvedValue(row({ 'posts.daily': { base: -1 } }));
    for (let reads = 1; reads <= 3; reads++) await readFresh(reads);
    expect(firingLogs()).toHaveLength(1);
    expect(firingLogs()[0][0]).toMatchObject({
      fallbacks: [{ id: 'posts.daily', reason: expect.any(String) }],
    });

    findKeyValue.mockResolvedValue(row({ 'comments.daily': { base: 0 } }));
    await readFresh(4);
    await vi.waitFor(() => expect(firingLogs()).toHaveLength(2));
  });
});
