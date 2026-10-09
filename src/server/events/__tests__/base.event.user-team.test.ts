import { beforeEach, describe, expect, it, vi } from 'vitest';

// getUserTeam reads manual team assignments from sysRedis. By default a failed
// read falls back to the computed team (cosmetic resolution must not 500 during
// an outage). With `strict`, the failure reaches the caller instead: selling a
// team-coloured item on a guessed team charges someone assigned by hand for a
// colour that isn't theirs.

const { mockHGetAll, mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockHGetAll: vi.fn(),
  mockLogSysRedisFailOpen: vi.fn(),
}));

vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  sysRedis: { hGetAll: mockHGetAll },
  redis: { hGet: vi.fn(), hSet: vi.fn(), del: vi.fn() },
  withSysReadDeadline: (p: Promise<unknown>) => p,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
vi.mock('~/server/integrations/discord', () => ({ discord: {} }));

import { createEvent } from '~/server/events/base.event';

const TEAMS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const event = createEvent('test-event' as Parameters<typeof createEvent>[0], {
  title: 'Test',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2026-02-01'),
  teams: TEAMS,
  bankIndex: -1,
  cosmeticName: 'Test Cosmetic',
  badgePrefix: 'Test',
});
const USER = 42;

describe('getUserTeam', () => {
  beforeEach(() => {
    mockHGetAll.mockReset();
    mockLogSysRedisFailOpen.mockReset();
  });

  it('returns a manual assignment over the computed team', async () => {
    const computed = await (async () => {
      mockHGetAll.mockResolvedValueOnce({});
      return event.getUserTeam(USER);
    })();
    const other = TEAMS.find((t) => t !== computed) as string;
    mockHGetAll.mockResolvedValue({ [USER]: other });

    expect(await event.getUserTeam(USER, { strict: true })).toBe(other);
  });

  it('by default falls back to the computed team when the read fails', async () => {
    mockHGetAll.mockRejectedValue(new Error('sysRedis down'));

    expect(TEAMS).toContain(await event.getUserTeam(USER));
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });

  it('with strict, rejects when the read fails instead of guessing', async () => {
    mockHGetAll.mockRejectedValue(new Error('sysRedis down'));

    await expect(event.getUserTeam(USER, { strict: true })).rejects.toThrow('sysRedis down');
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});
