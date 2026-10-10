import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * The self-heal as production builds it (`healEventPoints`), with only its leaves faked: the switch,
 * the event registry, the reconcile, the scoring phase and the referee. self-heal.test.ts covers the
 * heal's rules over injected deps; this pins that the real wiring honours the switch and reaches
 * the reconcile and the settle with the hourly job's lock.
 */

const leaves = vi.hoisted(() => ({
  on: true,
  sync: vi.fn(async () => [{ event: 'birthday2026', set: 2, removed: 0 }]),
  referee: vi.fn(async () => ({ season: 'live', rows: 3, changed: 1, final: false })),
}));
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => leaves.on,
  isEventPointsEnabledSync: () => leaves.on,
  onEventPointsSwitchOn: () => () => undefined,
}));
vi.mock('~/server/events/load-events', () => ({
  loadEvents: async () => [
    {
      name: 'birthday2026',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2999-01-01T00:00:00.000Z'),
      teams: ['Blue'],
      scoring: { capPerActorPerOwnerPerDay: 50, types: {}, newAccountDays: 7, finalizeAfterMs: 0 },
    },
  ],
}));
vi.mock('~/server/events/points/sync', () => ({ syncEventHats: leaves.sync }));
vi.mock('~/server/events/points/referee', () => ({ runEventPointsReferee: leaves.referee }));
vi.mock('~/server/events/event-access', () => ({
  getEventScoringPhase: async () => ({ from: new Date('2026-01-01T00:00:00.000Z') }),
}));

const { healEventPoints } = await import('~/server/events/points/self-heal');
const { jobLockKey } = await import('~/server/jobs/job-lock');

const sys = redisMock.sysRedis;
// Only the heal's own writes: its cooldown and the job lock.
const setKeys = () => sys.set.mock.calls.map(([key]) => String(key));

beforeEach(() => {
  vi.clearAllMocks();
  sys.set.mockResolvedValue('OK');
  sys.eval.mockResolvedValue(1);
});

describe('healEventPoints', () => {
  it('while off: writes nothing and runs nothing', async () => {
    leaves.on = false;
    try {
      healEventPoints('birthday2026', 'empty-map');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(leaves.sync).not.toHaveBeenCalled();
      expect(sys.set).not.toHaveBeenCalled();
    } finally {
      leaves.on = true;
    }
  });

  it("while on: reconciles and settles under the hourly settle job's lock", async () => {
    healEventPoints('birthday2026', 'missing-count-base');
    await vi.waitFor(() => expect(leaves.referee).toHaveBeenCalledTimes(1));
    expect(leaves.sync).toHaveBeenCalledTimes(1);
    expect(setKeys()).toEqual([
      expect.stringMatching(/:self-heal-cooldown:repair$/),
      jobLockKey('event-engine-leaderboard-update'),
    ]);
  });

  it('while on, with the lock unreachable: settles nothing', async () => {
    sys.set.mockImplementation(async (key: string) => {
      if (key === jobLockKey('event-engine-leaderboard-update')) throw new Error('timeout');
      return 'OK';
    });
    healEventPoints('birthday2026', 'empty-map');
    await vi.waitFor(() => expect(setKeys()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leaves.sync).not.toHaveBeenCalled();
  });
});
