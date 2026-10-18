import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from '~/server/events/base.event';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * STEP-7 sysRedis soft-dependency (Group A) — base.event.ts holiday-event reads.
 *
 * Two already-fail-open reads gained the missing `withSysReadDeadline` wrap:
 *   - getManualAssignment (hGet) — on the per-request cosmetic-resolution
 *     path (getUserTeam → getUserCosmeticId) during active events. Fail-open →
 *     no assignment → the user still gets a (deterministic-random) team.
 *   - getDiscordRoles (hGetAll) — event role-grant path. Fail-open → {} → skip
 *     the Discord role map for the outage window.
 *
 * Both were try/catch fail-open on a fast DOWN but PARKED ~11min on a silent
 * half-open. The SLOW tests are fail-on-revert: the underlying hGetAll NEVER
 * settles, so removing the wrap would hang the call → the test would TIME OUT.
 */

const { hGet, hGetAll, hSet, mockWithSysReadDeadline, mockLogSysRedisFailOpen, mockGetAllRoles } =
  vi.hoisted(() => ({
    hGet: vi.fn(),
    hGetAll: vi.fn(),
    hSet: vi.fn(async () => 1),
    mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
    mockLogSysRedisFailOpen: vi.fn(),
    mockGetAllRoles: vi.fn(async () => [] as { name: string; id: string }[]),
  }));

vi.mock('~/server/redis/client', () => ({
  redis: { hGet: vi.fn(), hSet: vi.fn(), del: vi.fn(), hDel: vi.fn() },
  sysRedis: { hGet, hGetAll, hSet },
  REDIS_KEYS: { COSMETICS: { IDS: 'cosmeticIds' }, EVENT: { CACHE: 'packed:event' } },
  REDIS_SUB_KEYS: {
    EVENT: {
      MANUAL_ASSIGNMENTS: 'manual-assignments',
      DISCORD_ROLES: 'discord-roles',
      COSMETICS: 'cosmetics',
    },
  },
  REDIS_SYS_KEYS: { EVENT: 'event' },
  withSysReadDeadline: mockWithSysReadDeadline,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
vi.mock('~/server/integrations/discord', () => ({ discord: { getAllRoles: mockGetAllRoles } }));

const definition = {
  title: 'Test Event',
  startDate: new Date('2020-01-01'),
  endDate: new Date('2999-01-01'),
  teams: ['Team1', 'Team2'],
  bankIndex: 0,
  cosmeticName: 'Test Cosmetic',
  badgePrefix: 'Test:',
} as unknown as Parameters<typeof createEvent>[1];

const event = createEvent('event:test' as Parameters<typeof createEvent>[0], definition);

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  hGet.mockResolvedValue(null);
  hGetAll.mockResolvedValue({});
});

describe('getUserTeam → getManualAssignment — sysRedis hGet (fail-open, park-bounded)', () => {
  it('happy path: honors a manual assignment; read wrapped; no fail-open log', async () => {
    hGet.mockImplementation(async (_key: string, field: string) =>
      field === '5' ? 'Team2' : null
    );
    await expect(event.getUserTeam(5)).resolves.toBe('Team2');
    // One field of the event's hash, never the whole hash.
    expect(hGet).toHaveBeenCalledWith('event:event:test:manual-assignments', '5');
    expect(hGetAll).not.toHaveBeenCalled();
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fail-open to no assignment → still returns a team; logSysRedisFailOpen fired', async () => {
    hGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const team = await event.getUserTeam(5);
    expect(definition.teams).toContain(team);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getManualAssignment',
      expect.any(Error),
      expect.objectContaining({ event: 'event:test' })
    );
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fail-open team (fail-on-revert)', async () => {
    hGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    const team = await event.getUserTeam(5);
    expect(definition.teams).toContain(team);
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getManualAssignment',
      expect.any(Error),
      expect.objectContaining({ event: 'event:test' })
    );
  });
});

describe('getDiscordRoles — sysRedis hGetAll (fail-open, park-bounded)', () => {
  it('happy path: cache hit → returns roles without hitting Discord; read wrapped; no log', async () => {
    hGetAll.mockResolvedValue({ Team1: 'role-1' });
    await expect(event.getDiscordRoles()).resolves.toEqual({ Team1: 'role-1' });
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockGetAllRoles).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGetAll throws → fail-open {} (Discord skipped); logSysRedisFailOpen fired', async () => {
    hGetAll.mockRejectedValue(new Error('sysRedis connection is down'));
    await expect(event.getDiscordRoles()).resolves.toEqual({});
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockGetAllRoles).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getDiscordRoles read',
      expect.any(Error),
      expect.objectContaining({ event: 'event:test' })
    );
  });

  it('SLOW/half-open: hGetAll NEVER settles + deadline REJECTS → fail-open {} (fail-on-revert)', async () => {
    hGetAll.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    await expect(event.getDiscordRoles()).resolves.toEqual({});
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'getDiscordRoles read',
      expect.any(Error),
      expect.objectContaining({ event: 'event:test' })
    );
  });
});
