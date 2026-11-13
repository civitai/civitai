import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

// getUserTeam reads manual team assignments from sysRedis. By default a failed
// read falls back to the computed team (cosmetic resolution must not 500 during
// an outage). With `strict`, the failure reaches the caller instead: selling a
// team-coloured item on a guessed team charges someone assigned by hand for a
// colour that isn't theirs.

const { mockLogSysRedisFailOpen } = vi.hoisted(() => ({
  mockLogSysRedisFailOpen: vi.fn(),
}));

// sysRedis comes from the canonical redis mock (setup.ts registers it).
const mockHGet = redisMock.sysRedis.hGet;
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
    mockHGet.mockReset();
    mockLogSysRedisFailOpen.mockReset();
  });

  it('returns a manual assignment over the computed team', async () => {
    const computed = await (async () => {
      mockHGet.mockResolvedValueOnce(null);
      return event.getUserTeam(USER);
    })();
    const other = TEAMS.find((t) => t !== computed) as string;
    mockHGet.mockImplementation(async (_key: string, field: string) =>
      field === String(USER) ? other : null
    );

    expect(await event.getUserTeam(USER, { strict: true })).toBe(other);
  });

  it('by default falls back to the computed team when the read fails', async () => {
    mockHGet.mockResolvedValueOnce(null);
    const computed = await event.getUserTeam(USER);
    mockHGet.mockRejectedValue(new Error('sysRedis down'));

    expect(await event.getUserTeam(USER)).toBe(computed);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });

  it('with strict, rejects when the read fails instead of guessing', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis down'));

    await expect(event.getUserTeam(USER, { strict: true })).rejects.toThrow('sysRedis down');
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});
