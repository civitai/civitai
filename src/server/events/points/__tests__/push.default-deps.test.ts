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

const { logToAxiom } = await import('~/server/logging/client');
const { drainEventPointsPush, markEventPointsDirty } = await import('~/server/events/points/push');
const { eventPointKeys, eventPointSeason, eventSeasonKeys, hatField, hatTopicId, previewTopicId } =
  await import('~/server/events/points/keys');

const event = {
  name: 'birthday2026',
  startDate: new Date('2026-01-01'),
  endDate: new Date('2999-01-01'),
  teams: ['Blue', 'Pink'],
};
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'claimed' };

// The interest set, as ZMSCORE reads it: topic -> when its mark lapses (ms).
const watch = new Map<string, number>();
const zmScore = () => redisMock.sysRedis.zmScore;
const markAll = (lapse = Date.now() + 60_000) => {
  watch.set(hatTopicId(HAT), lapse);
  watch.set('teams', lapse);
};

beforeEach(() => {
  topicSend.mockClear();
  watch.clear();
  zmScore().mockReset();
  zmScore().mockImplementation(async (key: string, members: string[]) =>
    key === eventPointKeys(event.name).watch ? members.map((m) => watch.get(m) ?? null) : []
  );
});

const totals = () => {
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
};

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

  it('sends nothing for topics nobody watches, or whose mark has lapsed', async () => {
    totals();
    markEventPointsDirty(event, HAT, new Date());
    expect(await drainEventPointsPush()).toEqual({ left: 0 });
    markAll(Date.now() - 1);
    markEventPointsDirty(event, HAT, new Date());
    expect(await drainEventPointsPush()).toEqual({ left: 0 });
    expect(topicSend).not.toHaveBeenCalled();
    // One interest-set read per flush, for the hat and the teams together.
    expect(zmScore().mock.calls).toEqual([
      [eventPointKeys(event.name).watch, [hatTopicId(HAT), 'teams']],
      [eventPointKeys(event.name).watch, [hatTopicId(HAT), 'teams']],
    ]);
  });

  it('fails closed: an interest-set read error sends nothing', async () => {
    totals();
    markAll();
    zmScore().mockRejectedValue(new Error('redis down'));
    vi.mocked(logToAxiom).mockClear();
    markEventPointsDirty(event, HAT, new Date());
    expect(await drainEventPointsPush()).toEqual({ left: 0 });
    expect(topicSend).not.toHaveBeenCalled();
    expect(
      vi.mocked(logToAxiom).mock.calls.map(([e]) => (e as { message?: string }).message)
    ).toEqual(['interest set read failed']);
  });

  it('pushes only the watched topic', async () => {
    totals();
    watch.set('teams', Date.now() + 60_000);
    markEventPointsDirty(event, HAT, new Date());
    await drainEventPointsPush();
    expect(topicSend.mock.calls.map(([s]) => (s as { target: string }).target)).toEqual([
      'event-points:teams',
    ]);
  });

  it('reads the watched totals and sends them through the signals client', async () => {
    totals();
    markAll();
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

// In the preview, a tester who was handed the keyed ids (and marked them) gets the preview season's
// totals pushed to the keyed topics; nothing goes to the public ones, and the key never leaves.
describe('the pusher in the preview', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const preview = {
    ...event,
    previewFrom: new Date(Date.now() - DAY),
    startDate: new Date(Date.now() + DAY),
  };
  const keyedHat = previewTopicId(preview.name, hatField(HAT));
  const keyedTeams = previewTopicId(preview.name, 'teams');
  const previewTotals = () => {
    const keys = eventSeasonKeys(preview.name, 'preview');
    const sys = redisMock.sysRedis;
    sys.get.mockResolvedValue(null);
    sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      key === keys.base('hat')
        ? ['7']
        : key === keys.base('team')
        ? ['3', '4']
        : fields.map(() => null)
    );
  };

  it("pushes the preview season's totals to the keyed topics that are watched", async () => {
    previewTotals();
    watch.set(keyedHat, Date.now() + 60_000);
    watch.set(keyedTeams, Date.now() + 60_000);
    expect(markEventPointsDirty(preview, HAT, new Date())).toBe(true);
    expect(await drainEventPointsPush()).toEqual({ left: 0 });
    expect(zmScore().mock.calls).toEqual([
      [eventPointKeys(preview.name).watch, [keyedHat, keyedTeams]],
    ]);
    expect(topicSend.mock.calls).toEqual([
      [
        {
          topic: `event-points:birthday2026:teams:${keyedTeams}`,
          target: 'event-points:teams',
          data: { event: 'birthday2026', teams: { Blue: 3, Pink: 4 } },
        },
      ],
      [
        {
          topic: `event-points:birthday2026:hat:${keyedHat}`,
          target: 'event-points:hat',
          data: { event: 'birthday2026', topicId: keyedHat, points: 7 },
        },
      ],
    ]);
  });

  it('sends nothing in the preview to marks under the public ids', async () => {
    previewTotals();
    watch.set(hatTopicId(HAT), Date.now() + 60_000);
    watch.set('teams', Date.now() + 60_000);
    markEventPointsDirty(preview, HAT, new Date());
    await drainEventPointsPush();
    expect(topicSend).not.toHaveBeenCalled();
  });

  it('marks nothing before the preview opens', () => {
    const early = { ...preview, previewFrom: new Date(Date.now() + 60_000) };
    expect(markEventPointsDirty(early, HAT, new Date())).toBe(false);
  });

  it('puts the key in no payload and no log line, even when a send fails', async () => {
    const { env } = await import('~/env/server');
    expect(env.NEXTAUTH_SECRET.length).toBeGreaterThan(0);
    previewTotals();
    watch.set(keyedHat, Date.now() + 60_000);
    watch.set(keyedTeams, Date.now() + 60_000);
    vi.mocked(logToAxiom).mockClear();
    topicSend.mockRejectedValueOnce(new Error('signals down'));
    markEventPointsDirty(preview, HAT, new Date());
    await drainEventPointsPush();
    const wire = JSON.stringify(topicSend.mock.calls);
    const logs = JSON.stringify(vi.mocked(logToAxiom).mock.calls);
    // The control: both were written to, and the keyed ids did go out.
    expect(wire).toContain(keyedHat);
    expect(logs).toContain('signals sends failed');
    expect(wire).not.toContain(env.NEXTAUTH_SECRET);
    expect(logs).not.toContain(env.NEXTAUTH_SECRET);
  });
});
