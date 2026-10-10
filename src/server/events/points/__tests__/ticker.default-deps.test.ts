import { describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as SignalClient from '~/utils/signal-client';

/**
 * tickEventPoints with its default deps: the real drain and reads over sysRedis, and the real
 * topicSend wiring. Only the signals client is faked. The ticker's other tests inject every dep.
 */

const { topicSend } = vi.hoisted(() => ({
  topicSend: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: { topicSend },
}));

const { tickEventPoints } = await import('~/server/events/points/ticker');
const { eventPointKeys, eventPointSeason, eventSeasonKeys, hatTopicId } = await import(
  '~/server/events/points/keys'
);

const event = {
  name: 'birthday2026',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2999-01-01'),
  teams: ['Blue', 'Pink'],
};
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed' };

describe('tickEventPoints with its default deps', () => {
  it('drains the changed set, reads the totals and sends them through the signals client', async () => {
    const keys = eventSeasonKeys(event.name, eventPointSeason(event.startDate, new Date()));
    const sys = redisMock.sysRedis;
    sys.sPop.mockImplementation(async (key: string) =>
      key === eventPointKeys(event.name).changed ? ['10:7:claimed'] : []
    );
    sys.get.mockResolvedValue(null);
    sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      key === keys.base('hat')
        ? ['30']
        : key === keys.base('team')
        ? ['100', '50']
        : fields.map(() => null)
    );

    await tickEventPoints(event);

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
