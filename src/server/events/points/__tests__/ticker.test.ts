import { describe, expect, it, vi } from 'vitest';
import { SignalMessages } from '~/server/common/enums';
import { hatField, hatTopicId } from '~/server/events/points/keys';
import type { TickDeps } from '~/server/events/points/ticker';
import {
  FAILURES_TO_STOP,
  MAX_HAT_SENDS_PER_TICK,
  SEND_CONCURRENCY,
  TICK_MS,
  TICK_WINDOW_MS,
  runEventPointsTicker,
  tickEventPoints,
} from '~/server/events/points/ticker';
import { eventPointsTicker, getTickerEvents } from '~/server/jobs/event-points-ticker';

const event = {
  name: 'birthday2026',
  startDate: new Date('2026-11-01'),
  endDate: new Date('2999-01-01'),
  teams: ['Blue', 'Pink'],
};
const hat = (i: number) => ({ ownerId: i, cosmeticId: 7, claimKey: `claim-${i}` });
type Sent = { topic: string; target: string; data: Record<string, unknown> };

// A changed set the fake drain pops from, like SPOP with a count.
function fakeDeps(changed: ReturnType<typeof hat>[]) {
  const set = [...changed];
  const sent: Sent[] = [];
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
const hatSends = (sent: Sent[]) => sent.filter((s) => s.target === SignalMessages.EventPointsHat);

describe('tickEventPoints', () => {
  it('sends at most MAX_HAT_SENDS_PER_TICK hats a tick and asks the drain for no more', async () => {
    const { deps, sent, remaining } = fakeDeps(Array.from({ length: 250 }, (_, i) => hat(i + 1)));
    await tickEventPoints(event, deps);
    expect(hatSends(sent).length).toBe(200);
    expect(deps.drainChangedHats).toHaveBeenCalledWith(event, 200);
    expect(remaining()).toBe(50);
  });

  it('caps at 200: a raised cap is a load decision, not a refactor', () => {
    // Bounds the POSTs a busy minute puts on signals until it can tell us who is subscribed
    // (868mfm4pp). Change it on purpose, with the signals owner, or not at all.
    expect(MAX_HAT_SENDS_PER_TICK).toBe(200);
  });

  it('pushes the team totals, then each hat total to its opaque topic', async () => {
    const { deps, sent } = fakeDeps([hat(1), hat(2)]);
    const result = await tickEventPoints(event, deps);
    expect(sent).toEqual([
      {
        topic: 'event-points:birthday2026:teams',
        target: SignalMessages.EventPointsTeams,
        data: { event: 'birthday2026', teams: { Blue: 100, Pink: 50 } },
      },
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
    ]);
    expect(result).toEqual({ drained: 2, sent: 3, failed: 0, dropped: 0, stopped: false });
    // The season comes from the event passed in, so both reads must get it whole.
    expect(deps.getHatPoints).toHaveBeenCalledWith(event, [hat(1), hat(2)]);
    expect(deps.getTeamPoints).toHaveBeenCalledWith(event);
    // The claim key never reaches a topic or payload.
    expect(JSON.stringify(sent)).not.toContain('claim-');
  });

  it('sends a hat the live read has no total for as 0', async () => {
    const { deps, sent } = fakeDeps([hat(1)]);
    deps.getHatPoints = vi.fn(async () => ({}));
    await tickEventPoints(event, deps);
    expect(hatSends(sent).map((s) => s.data.points)).toEqual([0]);
  });

  it('only sends hats the subscriber seam keeps, and skips the hat read when it keeps none', async () => {
    const { deps, sent } = fakeDeps([hat(1), hat(2)]);
    deps.selectWatchedHats = vi.fn(async (_e, hats) => hats.slice(1));
    await tickEventPoints(event, deps);
    expect(sent.map((s) => s.data.topicId ?? 'teams')).toEqual(['teams', hatTopicId(hat(2))]);

    const none = fakeDeps([hat(1)]);
    none.deps.selectWatchedHats = vi.fn(async () => []);
    await tickEventPoints(event, none.deps);
    expect(none.deps.getHatPoints).not.toHaveBeenCalled();
    expect(none.sent.map((s) => s.target)).toEqual([SignalMessages.EventPointsTeams]);
  });

  it('does nothing when no hat moved', async () => {
    const { deps, sent } = fakeDeps([]);
    expect(await tickEventPoints(event, deps)).toEqual({
      drained: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      stopped: false,
    });
    expect(sent).toEqual([]);
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
  });

  // The signals client's lane allows 30 in flight with a bounded queue that every push on the pod
  // shares; a tick filling it would shed chat and buzz pushes.
  // With the stop below, one run can time out at most SEND_CONCURRENCY + FAILURES_TO_STOP - 1 calls;
  // the breaker every push on the pod shares opens at 10 in 60s, and runs are a minute apart.
  it('can never time out enough calls in one run to open the shared breaker alone', () => {
    expect(2 * (SEND_CONCURRENCY + FAILURES_TO_STOP - 1)).toBeLessThan(10);
  });

  it(`never has more than ${SEND_CONCURRENCY} sends in flight`, async () => {
    const { deps } = fakeDeps(Array.from({ length: 200 }, (_, i) => hat(i + 1)));
    let inFlight = 0;
    let peak = 0;
    deps.topicSend = vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
    });
    await tickEventPoints(event, deps);
    expect(peak).toBe(SEND_CONCURRENCY);
    expect(deps.topicSend).toHaveBeenCalledTimes(201);
  });

  it('drops a failed send without re-queueing it, and still sends the rest', async () => {
    const { deps, sent, remaining } = fakeDeps([hat(1), hat(2)]);
    const send = deps.topicSend;
    deps.topicSend = vi.fn(async (args) => {
      if (args.data.topicId === hatTopicId(hat(1))) throw new Error('signals down');
      return send(args);
    });
    expect(await tickEventPoints(event, deps)).toEqual({
      drained: 2,
      sent: 2,
      failed: 1,
      dropped: 0,
      stopped: false,
    });
    expect(sent.map((s) => s.data.topicId ?? 'teams')).toEqual(['teams', hatTopicId(hat(2))]);
    expect(remaining()).toBe(0);
  });

  it('stops sending once signals has failed FAILURES_TO_STOP times, so it cannot trip the breaker', async () => {
    const { deps } = fakeDeps(Array.from({ length: 50 }, (_, i) => hat(i + 1)));
    deps.topicSend = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 0));
      throw new Error('timeout');
    });
    const result = await tickEventPoints(event, deps);
    // The first wave of 3 is in flight; the worker that fails before the second failure lands starts
    // one more, and nothing starts after it: 4 attempted of 51.
    expect(result).toEqual({ drained: 50, sent: 0, failed: 4, dropped: 47, stopped: true });
  });

  it('keeps sending through fewer failures than FAILURES_TO_STOP', async () => {
    const { deps } = fakeDeps(Array.from({ length: 20 }, (_, i) => hat(i + 1)));
    let n = 0;
    deps.topicSend = vi.fn(async () => {
      if (++n === 5) throw new Error('blip');
    });
    expect(await tickEventPoints(event, deps)).toEqual({
      drained: 20,
      sent: 20,
      failed: 1,
      dropped: 0,
      stopped: false,
    });
  });

  // After the end the page names the settled winner; a live team push must not reach it.
  it('stops pushing team totals once the event has ended, and still pushes hats', async () => {
    const { deps, sent } = fakeDeps([hat(1)]);
    await tickEventPoints(event, deps, { now: new Date('2999-01-01') });
    expect(sent.map((s) => s.target)).toEqual([SignalMessages.EventPointsHat]);
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
  });

  // The run's lock outlives its window by 35s; a slow tick must not carry the run past it.
  it('starts no send after the deadline, and drops what is left', async () => {
    const late = fakeDeps([hat(1), hat(2)]);
    expect(
      await tickEventPoints(event, late.deps, { deadline: 1_000, clock: () => 1_000 })
    ).toEqual({ drained: 2, sent: 0, failed: 0, dropped: 3, stopped: false });
    expect(late.sent).toEqual([]);

    // Each send takes 1s; the window closes 5s in, so sends stop being started there.
    const slow = fakeDeps(Array.from({ length: 30 }, (_, i) => hat(i + 1)));
    let t = 0;
    slow.deps.topicSend = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 0));
      t += 1_000;
    });
    const result = await tickEventPoints(event, slow.deps, { deadline: 5_000, clock: () => t });
    expect(result.sent).toBeGreaterThan(0);
    expect(result.sent).toBeLessThan(5 + SEND_CONCURRENCY);
    expect(result.dropped).toBe(31 - result.sent);
  });

  it('rejects the tick, sending nothing, when a live read fails', async () => {
    const { deps, sent } = fakeDeps([hat(1)]);
    deps.getTeamPoints = vi.fn(async () => {
      throw new Error('sysredis down');
    });
    await expect(tickEventPoints(event, deps)).rejects.toThrow('sysredis down');
    expect(sent).toEqual([]);
  });

  it('still pushes the hats when the team send fails', async () => {
    const { deps, sent } = fakeDeps([hat(1)]);
    const send = deps.topicSend;
    deps.topicSend = vi.fn(async (args) => {
      if (args.target === SignalMessages.EventPointsTeams) throw new Error('signals down');
      return send(args);
    });
    expect(await tickEventPoints(event, deps)).toMatchObject({ sent: 1, failed: 1 });
    expect(hatSends(sent)).toHaveLength(1);
  });
});

describe('runEventPointsTicker', () => {
  // Every fake here resolves at once, so the run is a pure microtask loop that vitest's timeout
  // cannot interrupt. These deps cancel the run after 50 ticks: a broken window ends in a failed
  // count, not a hung suite.
  function harness(tick: (now: () => number, advance: (ms: number) => void) => Promise<unknown>) {
    let t = 1_000_000;
    const start = t;
    let calls = 0;
    const tickTimes: number[] = [];
    const deps = {
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      isCanceled: () => calls >= 50,
      tick: async () => {
        calls++;
        tickTimes.push(t - start);
        await tick(
          () => t,
          (ms) => (t += ms)
        );
      },
    };
    return { deps, tickTimes, elapsed: () => t - start };
  }

  it('ticks every 5s and stops before the next minute', async () => {
    const h = harness(async () => undefined);
    const { ticks } = await runEventPointsTicker(() => [event], h.deps);
    expect(TICK_MS).toBe(5_000);
    expect(TICK_WINDOW_MS).toBe(55_000);
    expect(ticks).toBe(11);
    expect(h.tickTimes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((s) => s * 1000));
  });

  it('never stacks ticks: a slow tick shortens the wait, and the run still ends in the window', async () => {
    const h = harness(async (_now, advance) => advance(7_000));
    await runEventPointsTicker(() => [event], h.deps);
    expect(h.tickTimes).toEqual([0, 7, 14, 21, 28, 35, 42, 49].map((s) => s * 1000));
    expect(h.elapsed()).toBeLessThan(60_000);
  });

  it('stops when the job is canceled', async () => {
    let n = 0;
    const h = harness(async () => void n++);
    const { ticks } = await runEventPointsTicker(() => [event], {
      ...h.deps,
      isCanceled: () => n >= 2,
    });
    expect(ticks).toBe(2);
  });

  it("hands every tick the end of the run's window", async () => {
    const deadlines: number[] = [];
    const h = harness(async () => undefined);
    await runEventPointsTicker(() => [event], {
      ...h.deps,
      tick: async (_e, deadline) => void deadlines.push(deadline),
    });
    expect(new Set(deadlines)).toEqual(new Set([1_000_000 + TICK_WINDOW_MS]));
  });

  it('leaves the remaining events for the next run once a slow one used up the window', async () => {
    const seen: string[] = [];
    let t = 1_000_000;
    const { ticks } = await runEventPointsTicker(
      () => [
        { ...event, name: 'a' },
        { ...event, name: 'b' },
      ],
      {
        now: () => t,
        sleep: async (ms) => void (t += ms),
        isCanceled: () => seen.length >= 50,
        tick: async (e) => {
          seen.push(e.name);
          t += 60_000;
        },
      }
    );
    expect(seen).toEqual(['a']);
    expect(ticks).toBe(1);
  });

  it('ends the run when a tick stopped on signals failures', async () => {
    const seen: string[] = [];
    const h = harness(async () => undefined);
    const { ticks, stopped } = await runEventPointsTicker(
      () => [
        { ...event, name: 'a' },
        { ...event, name: 'b' },
      ],
      {
        ...h.deps,
        tick: async (e) => {
          seen.push(e.name);
          return { stopped: seen.length === 3 };
        },
      }
    );
    // Tick 1: a, b. Tick 2: a stops it; b is not ticked and no tick 3 runs.
    expect(seen).toEqual(['a', 'b', 'a']);
    expect({ ticks, stopped }).toEqual({ ticks: 2, stopped: true });
  });

  it("one event's failure does not skip the next event or the next tick", async () => {
    const seen: string[] = [];
    const h = harness(async () => undefined);
    const { ticks } = await runEventPointsTicker(
      () => [
        { ...event, name: 'a' },
        { ...event, name: 'b' },
      ],
      {
        ...h.deps,
        tick: async (e) => {
          seen.push(e.name);
          if (e.name === 'a') throw new Error('boom');
        },
        isCanceled: () => seen.length >= 100,
      }
    );
    expect(ticks).toBe(11);
    expect(seen.filter((x) => x === 'b')).toHaveLength(11);
  });
});

describe('the event-points-ticker job', () => {
  // Minute cron, and a lock that outlives the 55s run so the next minute cannot overlap it.
  it('runs every minute under a 90s lock', () => {
    expect(eventPointsTicker.cron).toBe('* * * * *');
    expect(eventPointsTicker.options.lockExpiration).toBe(90);
  });
});

describe('getTickerEvents', () => {
  const base = {
    name: 'e',
    teams: ['Blue'],
    startDate: new Date('2026-11-01T00:00:00Z'),
    endDate: new Date('2026-12-01T00:00:00Z'),
    previewFrom: new Date('2026-10-20T00:00:00Z'),
    scoring: { finalizeAfterMs: 24 * 60 * 60 * 1000 },
  };
  const at = (iso: string, e: Partial<typeof base> = {}) =>
    getTickerEvents([{ ...base, ...e }], new Date(iso)).map((x) => x.name);

  // Signals topics are open to any subscriber; the preview's totals are for previewers only.
  it('ticks scored events from the start, not the preview, until an hour after scoring finalizes', () => {
    expect(at('2026-10-25T00:00:00Z')).toEqual([]);
    expect(at('2026-10-31T23:59:59Z')).toEqual([]);
    expect(at('2026-11-01T00:00:00Z')).toEqual(['e']);
    expect(at('2026-12-02T01:00:00Z')).toEqual(['e']);
    expect(at('2026-12-02T01:00:01Z')).toEqual([]);
    // Follows the event's own finalize window, not a fixed tail.
    expect(
      at('2026-12-03T01:00:00Z', { scoring: { finalizeAfterMs: 48 * 60 * 60 * 1000 } })
    ).toEqual(['e']);
  });

  // The season comes from startDate, and the ticker's end-of-event freeze from endDate.
  it('passes the real start and end dates through', () => {
    expect(getTickerEvents([base], new Date('2026-11-05T00:00:00Z'))).toEqual([
      { name: 'e', startDate: base.startDate, endDate: base.endDate, teams: ['Blue'] },
    ]);
  });

  it('skips events without scoring', () => {
    expect(getTickerEvents([{ ...base, scoring: undefined }], new Date('2026-11-05'))).toEqual([]);
  });
});
