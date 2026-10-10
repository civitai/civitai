import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as SignalClient from '~/utils/signal-client';

/**
 * The pusher with its default deps: the real reads over sysRedis and the real topicSend wiring. Only
 * the signals client and the kill switch's reading are faked. The pusher's other tests inject every
 * dep.
 */

const { topicSend } = vi.hoisted(() => ({
  topicSend: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: { topicSend },
}));

const engine = vi.hoisted(() => ({ on: true }));
vi.mock('~/server/events/points/enabled', () => ({
  isEventPointsEnabled: async () => engine.on,
  isEventPointsEnabledSync: () => engine.on,
}));

const { drainEventPointsPush, markEventPointsDirty } = await import('~/server/events/points/push');
const { eventPointSeason, eventSeasonKeys, hatTopicId } = await import(
  '~/server/events/points/keys'
);

const event = {
  name: 'birthday2026',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2999-01-01'),
  teams: ['Blue', 'Pink'],
};
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed' };

beforeEach(() => topicSend.mockClear());

describe('the pusher with its default deps', () => {
  it('reads the kill switch: off, an award marks and sends nothing', async () => {
    engine.on = false;
    try {
      markEventPointsDirty(event, HAT, new Date());
      expect(await drainEventPointsPush()).toEqual({ left: 0 });
      expect(topicSend).not.toHaveBeenCalled();
    } finally {
      engine.on = true;
    }
  });

  it('reads the totals and sends them through the signals client', async () => {
    const keys = eventSeasonKeys(event.name, eventPointSeason(event.startDate, new Date()));
    const sys = redisMock.sysRedis;
    sys.get.mockResolvedValue(null);
    sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      key === keys.base('hat')
        ? ['30']
        : key === keys.base('team')
        ? ['100', '50']
        : fields.map(() => null)
    );

    markEventPointsDirty(event, HAT, new Date());
    expect(await drainEventPointsPush()).toEqual({ left: 0 });

    const topicId = hatTopicId(HAT);
    expect(topicSend.mock.calls).toEqual([
      [
        {
          topic: 'event-points:birthday2026:teams',
          target: 'event-points:teams',
          data: { event: 'birthday2026', teams: { Blue: 100, Pink: 50 } },
        },
      ],
      [
        {
          topic: `event-points:birthday2026:hat:${topicId}`,
          target: 'event-points:hat',
          data: { event: 'birthday2026', topicId, points: 30 },
        },
      ],
    ]);
  });
});
