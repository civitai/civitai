import { describe, expect, it, vi } from 'vitest';
import { SignalMessages } from '~/server/common/enums';
import { hatField, hatTopicId } from '~/server/events/points/keys';
import type { TickDeps } from '~/server/events/points/ticker';
import {
  MAX_HAT_SENDS_PER_TICK,
  TICK_MS,
  TICK_WINDOW_MS,
  runEventPointsTicker,
  tickEventPoints,
} from '~/server/events/points/ticker';
import { getTickerEvents } from '~/server/jobs/event-points-ticker';

const event = { name: 'birthday2026', startDate: new Date('2026-11-01'), teams: ['Blue', 'Pink'] };
const hat = (i: number) => ({ ownerId: i, cosmeticId: 7, claimKey: `claim-${i}` });

// A changed set the fake drain pops from, like SPOP with a count.
function fakeDeps(changed: ReturnType<typeof hat>[]) {
  const set = [...changed];
  const sent: { topic: string; target: string; data: Record<string, unknown> }[] = [];
  const deps: TickDeps = {
    drainChangedHats: vi.fn(async (_e, max: number) => set.splice(0, max)),
    selectWatchedHats: vi.fn(async (_e, hats) => hats),
    getHatPoints: vi.fn(async (_e, hats) =>
      Object.fromEntries(hats.map((h) => [hatField(h), h.ownerId * 10]))
    ),
    getTeamPoints: vi.fn(async () => ({ Blue: 100, Pink: 50 })),
    topicSend: vi.fn(async (args) => {
      sent.push(args);
    }),
  };
  return { deps, sent, remaining: () => set.length };
}

describe('tickEventPoints', () => {
  it('sends at most MAX_HAT_SENDS_PER_TICK hats a tick and leaves the rest in the changed set', async () => {
    const { deps, sent, remaining } = fakeDeps(Array.from({ length: 250 }, (_, i) => hat(i + 1)));
    await tickEventPoints(event, deps);
    const hatSends = sent.filter((s) => s.target === SignalMessages.EventPointsHat);
    expect(hatSends.length).toBe(200);
    expect(remaining()).toBe(50);
    expect(deps.drainChangedHats).toHaveBeenCalledWith(event, 200);
  });

  it('caps at 200: a raised cap is a load decision, not a refactor', () => {
    // Bounds the POSTs a busy minute puts on signals until it can tell us who is subscribed
    // (868mfm4pp). Change it on purpose, with the signals owner, or not at all.
    expect(MAX_HAT_SENDS_PER_TICK).toBe(200);
  });

  it("pushes each hat's total to its opaque topic, then the team totals once", async () => {
    const { deps, sent } = fakeDeps([hat(1), hat(2)]);
    const result = await tickEventPoints(event, deps);
    expect(sent).toEqual([
      {
        topic: `event-points:birthday2026:hat:${hatTopicId(hat(1))}`,
        target: SignalMessages.EventPointsHat,
        data: { event: 'birthday2026', topicId: hatTopicId(hat(1)), points: 10 },
      },
      {
        topic: `event-points:birthday2026:hat:${hatTopicId(hat(2))}`,
        target: SignalMessages.EventPointsHat,
        data: { event: 'birthday2026', topicId: hatTopicId(hat(2)), points: 20 },
      },
      {
        topic: 'event-points:birthday2026:teams',
        target: SignalMessages.EventPointsTeams,
        data: { event: 'birthday2026', teams: { Blue: 100, Pink: 50 } },
      },
    ]);
    expect(result).toEqual({ drained: 2, sent: 3, failed: 0 });
    // The claim key never reaches a topic or payload.
    expect(JSON.stringify(sent)).not.toContain('claim-');
  });

  it('only sends hats the subscriber seam keeps, but still pushes teams', async () => {
    const { deps, sent } = fakeDeps([hat(1), hat(2)]);
    deps.selectWatchedHats = vi.fn(async (_e, hats) => hats.slice(1));
    await tickEventPoints(event, deps);
    expect(sent.map((s) => s.data.topicId ?? 'teams')).toEqual([hatTopicId(hat(2)), 'teams']);
  });

  it('does nothing when no hat moved', async () => {
    const { deps, sent } = fakeDeps([]);
    expect(await tickEventPoints(event, deps)).toEqual({ drained: 0, sent: 0, failed: 0 });
    expect(sent).toEqual([]);
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
  });

  it('drops a failed send without re-queueing it, and still sends the rest', async () => {
    const { deps, sent, remaining } = fakeDeps([hat(1), hat(2)]);
    const send = deps.topicSend;
    deps.topicSend = vi.fn(async (args) => {
      if (args.data.topicId === hatTopicId(hat(1))) throw new Error('signals down');
      return send(args);
    });
    expect(await tickEventPoints(event, deps)).toEqual({ drained: 2, sent: 2, failed: 1 });
    expect(sent.map((s) => s.data.topicId ?? 'teams')).toEqual([hatTopicId(hat(2)), 'teams']);
    expect(remaining()).toBe(0);
  });
});

describe('runEventPointsTicker', () => {
  function clock() {
    let t = 1_000_000;
    return {
      now: () => t,
      advance: (ms: number) => (t += ms),
      sleep: async (ms: number) => void (t += ms),
    };
  }

  it('ticks every 5s and stops before the next minute', async () => {
    const c = clock();
    const tickTimes: number[] = [];
    const start = c.now();
    const { ticks } = await runEventPointsTicker(() => [event], {
      now: c.now,
      sleep: c.sleep,
      isCanceled: () => false,
      tick: async () => void tickTimes.push(c.now() - start),
    });
    expect(TICK_MS).toBe(5_000);
    expect(TICK_WINDOW_MS).toBe(55_000);
    expect(tickTimes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((s) => s * 1000));
    expect(ticks).toBe(11);
  });

  it('never stacks ticks: a slow tick shortens the wait, and the run still ends in the window', async () => {
    const c = clock();
    const start = c.now();
    const tickTimes: number[] = [];
    await runEventPointsTicker(() => [event], {
      now: c.now,
      sleep: c.sleep,
      isCanceled: () => false,
      tick: async () => {
        tickTimes.push(c.now() - start);
        c.advance(7_000);
      },
    });
    expect(tickTimes).toEqual([0, 7, 14, 21, 28, 35, 42, 49].map((s) => s * 1000));
    expect(c.now() - start).toBeLessThan(60_000);
  });

  it('stops when the job is canceled', async () => {
    const c = clock();
    let n = 0;
    const { ticks } = await runEventPointsTicker(() => [event], {
      now: c.now,
      sleep: c.sleep,
      isCanceled: () => n >= 2,
      tick: async () => void n++,
    });
    expect(ticks).toBe(2);
  });

  it("one event's failure does not skip the next event or the next tick", async () => {
    const c = clock();
    const seen: string[] = [];
    const { ticks } = await runEventPointsTicker(
      () => [
        { ...event, name: 'a' },
        { ...event, name: 'b' },
      ],
      {
        now: c.now,
        sleep: c.sleep,
        isCanceled: () => false,
        tick: async (e) => {
          seen.push(e.name);
          if (e.name === 'a') throw new Error('boom');
        },
      }
    );
    expect(ticks).toBe(11);
    expect(seen.filter((x) => x === 'b')).toHaveLength(11);
  });
});

describe('getTickerEvents', () => {
  const base = {
    name: 'e',
    teams: ['Blue'],
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: new Date('2026-12-01T00:00:00Z'),
    previewFrom: new Date('2026-10-20T00:00:00Z'),
    scoring: {},
  };
  const at = (iso: string) => getTickerEvents([base], new Date(iso)).map((e) => e.name);

  it('ticks scored events from the preview through two days after the end', () => {
    expect(at('2026-10-19T23:59:59Z')).toEqual([]);
    expect(at('2026-10-20T00:00:00Z')).toEqual(['e']);
    expect(at('2026-12-03T00:00:00Z')).toEqual(['e']);
    expect(at('2026-12-03T00:00:01Z')).toEqual([]);
  });

  it('passes the real start date, never the preview start: the season is derived from it', () => {
    expect(getTickerEvents([base], new Date('2026-10-25T00:00:00Z'))[0].startDate).toEqual(
      base.startDate
    );
  });

  it('skips events without scoring', () => {
    expect(getTickerEvents([{ ...base, scoring: undefined }], new Date('2026-11-05'))).toEqual([]);
  });
});
