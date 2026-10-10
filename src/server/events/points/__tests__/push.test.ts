import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushDeps } from '~/server/events/points/push';

const {
  BREAKER_COOL_OFF_MS,
  createEventPointsPusher,
  FAILURES_PER_COOL_OFF,
  FAILURES_TO_OPEN,
  MAX_DIRTY_HATS,
  MAX_SENDS_PER_FLUSH,
  PUSH_WINDOW_MS,
  SEND_CONCURRENCY,
} = await import('~/server/events/points/push');
const { hatField, hatTopicId } = await import('~/server/events/points/keys');

const NOW = new Date('2026-11-05T12:00:00.000Z');
const event = {
  name: 'birthday2026',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: ['Blue', 'Pink'],
};
// A bought hat's claim key is its purchase's transaction id: it must never reach a topic or payload.
const HAT = { ownerId: 10, cosmeticId: 7, claimKey: 'tx-secret-claim' };
const hat = (ownerId: number) => ({ ownerId, cosmeticId: 7, claimKey: `claim-${ownerId}` });

type Sent = Parameters<PushDeps['topicSend']>[0];

function setup(overrides: Partial<PushDeps> = {}) {
  const sent: Sent[] = [];
  const deps: PushDeps = {
    selectWatched: vi.fn(async (_e, hats, teams) => ({ hats, teams })),
    claimTeamsPush: vi.fn(async () => true),
    // Each hat's total is its owner id, so a payload shows which hat it carries.
    getHatPoints: vi.fn(async (_e, hats) =>
      Object.fromEntries(hats.map((h) => [hatField(h), h.ownerId]))
    ),
    getTeamPoints: vi.fn(async () => ({ Blue: 900, Pink: 40 })),
    topicSend: vi.fn(async (args: Sent) => void sent.push(args)),
    isEnabled: () => true,
    ...overrides,
  };
  return { pusher: createEventPointsPusher(deps), deps, sent };
}

const teamsSend = (teams = { Blue: 900, Pink: 40 }) => ({
  topic: 'event-points:birthday2026:teams',
  target: 'event-points:teams',
  data: { event: 'birthday2026', teams },
});
const hatSend = (h: typeof HAT, points: number) => {
  const topicId = hatTopicId(h);
  return {
    topic: `event-points:birthday2026:hat:${topicId}`,
    target: 'event-points:hat',
    data: { event: 'birthday2026', topicId, points },
  };
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('event points pusher', () => {
  // One lease shared by every server, as sysRedis holds it: free once its window has passed.
  function sharedLease() {
    let heldUntil = 0;
    return vi.fn(async () => {
      if (Date.now() < heldUntil) return false;
      heldUntil = Date.now() + PUSH_WINDOW_MS;
      return true;
    });
  }

  it('sends the team totals from one server per window, and the others try again', async () => {
    const claimTeamsPush = sharedLease();
    const a = setup({ claimTeamsPush });
    const b = setup({ claimTeamsPush });
    a.pusher.markDirty(event, HAT, NOW);
    b.pusher.markDirty(event, hat(11), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    const teamSends = () =>
      [...a.sent, ...b.sent].filter((s) => s.target === 'event-points:teams').length;
    expect(teamSends()).toBe(1);
    // Hats are each server's own and always go.
    expect(a.sent).toContainEqual(hatSend(HAT, 10));
    expect(b.sent).toContainEqual(hatSend(hat(11), 11));

    // The server that lost kept its teams dirty and sends them in the next window.
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(teamSends()).toBe(2);
    await vi.advanceTimersByTimeAsync(5 * PUSH_WINDOW_MS);
    expect(teamSends()).toBe(2);
  });

  // Each loser tries once more; a second loss means the holder read after its grant.
  it('sends the totals of a burst across many servers about once, not once per server', async () => {
    const claimTeamsPush = sharedLease();
    const servers = [1, 2, 3, 4, 5].map(() => setup({ claimTeamsPush }));
    servers.forEach((s, i) => s.pusher.markDirty(event, hat(20 + i), NOW));
    await vi.advanceTimersByTimeAsync(10 * PUSH_WINDOW_MS);
    const teamSends = servers
      .flatMap((s) => s.sent)
      .filter((s) => s.target === 'event-points:teams');
    expect(teamSends).toHaveLength(2);
    expect(servers.every((s) => s.pusher.dirtyCount() === 0)).toBe(true);
  });

  it('keeps the teams after a loss inside the same window, and drops them after a later one', async () => {
    const { pusher, sent } = setup({ claimTeamsPush: vi.fn(async () => false) });
    pusher.markDirty(event, HAT, NOW);
    await pusher.flush();
    await pusher.flush();
    // Both losses were to the same lease, which may predate this server's grant.
    expect(pusher.dirtyCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(pusher.dirtyCount()).toBe(0);
    expect(sent.filter((s) => s.target === 'event-points:teams')).toEqual([]);
  });

  it('a new grant after a loss gets its own tries', async () => {
    const claimTeamsPush = vi.fn(async () => false);
    const { pusher } = setup({ claimTeamsPush });
    pusher.markDirty(event, HAT, NOW);
    await pusher.flush();
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS / 2);
    pusher.markDirty(event, HAT, new Date());
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    // The second loss came after a fresh mark, so it counts as that mark's first.
    expect(pusher.dirtyCount()).toBe(1);
  });

  it('claims no lease when nobody watches the team totals', async () => {
    const claimTeamsPush = vi.fn(async () => true);
    const { pusher } = setup({
      claimTeamsPush,
      selectWatched: vi.fn(async (_e, hats) => ({ hats, teams: false })),
    });
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(claimTeamsPush).not.toHaveBeenCalled();
  });

  it('reads no team totals for a window it did not lease', async () => {
    const { pusher, sent, deps } = setup({ claimTeamsPush: vi.fn(async () => false) });
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
    expect(sent).toEqual([hatSend(HAT, 10)]);
  });

  it('pushes the dirty hat and its team once the window closes, with exact payloads', async () => {
    const { pusher, sent } = setup();
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([teamsSend(), hatSend(HAT, 10)]);
  });

  it('collapses many awards inside one window into one push per topic', async () => {
    const { pusher, sent, deps } = setup();
    for (let i = 0; i < 20; i++) pusher.markDirty(event, HAT, NOW);
    pusher.markDirty(event, hat(11), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([teamsSend(), hatSend(HAT, 10), hatSend(hat(11), 11)]);
    // One batched read per scope.
    expect(deps.getHatPoints).toHaveBeenCalledTimes(1);
    expect(deps.getTeamPoints).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS * 5);
    expect(sent).toHaveLength(3);
  });

  it('starts at most MAX_SENDS_PER_FLUSH sends a flush and keeps the rest dirty for the next window', async () => {
    expect(MAX_SENDS_PER_FLUSH).toBe(200);
    const { pusher, sent } = setup();
    for (let owner = 1; owner <= 250; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toHaveLength(200);
    expect(sent[0]).toEqual(teamsSend());
    expect(sent.slice(1).map((s) => s.data.points)).toEqual(range(1, 199));
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toHaveLength(251);
    expect(sent.slice(200).map((s) => s.data.points)).toEqual(range(200, 250));
  });

  it(`sends at most ${SEND_CONCURRENCY} at once`, async () => {
    let inFlight = 0;
    let peak = 0;
    const { pusher } = setup({
      topicSend: vi.fn(async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      }),
    });
    for (let owner = 1; owner <= 20; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 1000);
    expect(peak).toBe(SEND_CONCURRENCY);
  });

  it(`stops pushing after ${FAILURES_TO_OPEN} failures in a row, drops what is dirty, and resumes after the cool-off`, async () => {
    expect(FAILURES_TO_OPEN).toBe(2);
    expect(BREAKER_COOL_OFF_MS).toBe(60_000);
    let failing = true;
    const attempts: Sent[] = [];
    const { pusher, sent } = setup({
      topicSend: vi.fn(async (args: Sent) => {
        attempts.push(args);
        await new Promise((r) => setTimeout(r, 10));
        if (failing) throw new Error('signals down');
        sent.push(args);
      }),
    });
    for (let owner = 1; owner <= 50; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 100);
    // The first failure's worker starts one more send before the second failure lands; nothing
    // starts once the breaker opens. This is the bound the signals client's own breaker relies on.
    const bound = SEND_CONCURRENCY + FAILURES_TO_OPEN - 1;
    expect(attempts).toHaveLength(bound);
    expect(pusher.isOpen()).toBe(true);
    expect(pusher.dirtyCount()).toBe(0);

    // Awards during the cool-off are not kept.
    failing = false;
    pusher.markDirty(event, HAT, new Date());
    expect(pusher.dirtyCount()).toBe(0);
    // Opened at about +1010ms (the window, then one 10ms send); now about +1100ms.
    await vi.advanceTimersByTimeAsync(BREAKER_COOL_OFF_MS - 200);
    expect(attempts).toHaveLength(bound);
    expect(pusher.isOpen()).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(pusher.isOpen()).toBe(false);
    pusher.markDirty(event, HAT, new Date());
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 100);
    expect(sent).toEqual([teamsSend(), hatSend(HAT, 10)]);
  });

  it('a success between failures resets the count', async () => {
    let call = 0;
    const { pusher } = setup({
      topicSend: vi.fn(async () => {
        // fail, succeed, fail, succeed...: 3 failures, never 2 in a row
        if (call++ % 2 === 0) throw new Error('flaky');
      }),
      selectWatched: vi.fn(async (_e, hats) => ({ hats, teams: false })),
    });
    for (let owner = 1; owner <= 6; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(call).toBe(6);
    expect(pusher.isOpen()).toBe(false);
  });

  // A brownout: signals mostly works, but sends time out now and then. Without a count over time,
  // a single flush could put ~20 timeouts into the signals client's shared breaker (10 per 60s).
  it(`stops pushing after ${FAILURES_PER_COOL_OFF} failures within a cool-off, even with successes between`, async () => {
    expect(FAILURES_PER_COOL_OFF).toBe(4);
    let call = 0;
    let failures = 0;
    const { pusher } = setup({
      topicSend: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        if (call++ % 3 === 0) {
          failures++;
          throw new Error('timeout');
        }
      }),
    });
    for (let owner = 1; owner <= 100; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 5_000);
    expect(pusher.isOpen()).toBe(true);
    expect(failures).toBeGreaterThanOrEqual(FAILURES_PER_COOL_OFF);
    expect(failures).toBeLessThanOrEqual(FAILURES_PER_COOL_OFF + SEND_CONCURRENCY - 1);
    expect(call).toBeLessThan(20);
  });

  it('forgets failures older than a cool-off', async () => {
    let failNext = 0;
    const { pusher } = setup({
      topicSend: vi.fn(async () => {
        if (failNext > 0) {
          failNext--;
          throw new Error('timeout');
        }
      }),
      selectWatched: vi.fn(async (_e, hats) => ({ hats, teams: false })),
    });
    // Three single failures, each followed by a success, inside one cool-off.
    for (let i = 0; i < 3; i++) {
      failNext = 1;
      pusher.markDirty(event, hat(1), new Date());
      pusher.markDirty(event, hat(2), new Date());
      await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    }
    expect(pusher.isOpen()).toBe(false);
    // A cool-off later, a fourth failure is the only recent one.
    await vi.advanceTimersByTimeAsync(BREAKER_COOL_OFF_MS + 1);
    failNext = 1;
    pusher.markDirty(event, hat(1), new Date());
    pusher.markDirty(event, hat(2), new Date());
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(pusher.isOpen()).toBe(false);
  });

  it(`keeps at most ${MAX_DIRTY_HATS} hats dirty per event, and still takes marks for those it has`, () => {
    const { pusher } = setup();
    for (let owner = 1; owner <= MAX_DIRTY_HATS; owner++)
      expect(pusher.markDirty(event, hat(owner), NOW)).toBe(true);
    expect(pusher.markDirty(event, hat(MAX_DIRTY_HATS + 1), NOW)).toBe(false);
    expect(pusher.markDirty(event, hat(1), NOW)).toBe(true);
    // Every hat plus the team.
    expect(pusher.pending()).toBe(MAX_DIRTY_HATS + 1);
  });

  it('sends 0 for a hat the read has no total for', async () => {
    const { pusher, sent } = setup({ getHatPoints: vi.fn(async () => ({})) });
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([teamsSend(), hatSend(HAT, 0)]);
  });

  it('reads nothing for a scope nobody is watching', async () => {
    const { pusher, sent, deps } = setup({
      selectWatched: vi.fn(async () => ({ hats: [], teams: false })),
    });
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(deps.selectWatched).toHaveBeenCalledTimes(1);
    expect(deps.getHatPoints).not.toHaveBeenCalled();
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('pushes no team totals once the event has ended, but still pushes the hats', async () => {
    const { pusher, sent, deps } = setup();
    const ended = { ...event, endDate: NOW };
    pusher.markDirty(ended, HAT, new Date(NOW.getTime() - 1));
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([hatSend(HAT, 10)]);
    expect(deps.getTeamPoints).not.toHaveBeenCalled();
  });

  it('with the kill switch off, marks nothing, and drops what was marked before it went off', async () => {
    let on = false;
    const { pusher, sent, deps } = setup({ isEnabled: () => on });
    pusher.markDirty(event, HAT, NOW);
    expect(pusher.dirtyCount()).toBe(0);

    on = true;
    pusher.markDirty(event, HAT, NOW);
    expect(pusher.dirtyCount()).toBe(1);
    on = false;
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([]);
    expect(deps.getHatPoints).not.toHaveBeenCalled();
    expect(pusher.dirtyCount()).toBe(0);

    // The control: switched back on, the same mark goes out.
    on = true;
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([teamsSend(), hatSend(HAT, 10)]);
  });

  it('never marks a preview award', async () => {
    const { pusher, sent } = setup();
    pusher.markDirty(event, HAT, new Date(event.startDate.getTime() - 1));
    expect(pusher.dirtyCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([]);
    pusher.markDirty(event, HAT, event.startDate);
    expect(pusher.dirtyCount()).toBe(1);
  });

  it('puts no claim key in any topic or payload', async () => {
    const { pusher, deps } = setup();
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    const wire = JSON.stringify(vi.mocked(deps.topicSend).mock.calls);
    // The hat did go out, and the field it is read by holds the claim key.
    expect(wire).toContain(hatTopicId(HAT));
    expect(hatField(HAT)).toContain(HAT.claimKey);
    expect(wire.includes(HAT.claimKey)).toBe(false);
  });

  it('pushes only the hats and team standings the seams say are watched', async () => {
    const { pusher, sent } = setup({
      selectWatched: vi.fn(async (_e, hats) => ({
        hats: hats.filter((h) => h.ownerId === 11),
        teams: false,
      })),
    });
    pusher.markDirty(event, HAT, NOW);
    pusher.markDirty(event, hat(11), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([hatSend(hat(11), 11)]);
  });

  it('a failed read drops what it took, and later marks still push', async () => {
    const getTeamPoints = vi
      .fn<PushDeps['getTeamPoints']>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue({ Blue: 1, Pink: 2 });
    const { pusher, sent } = setup({ getTeamPoints });
    pusher.markDirty(event, HAT, NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([]);
    expect(pusher.dirtyCount()).toBe(0);
    pusher.markDirty(event, HAT, new Date());
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(sent).toEqual([teamsSend({ Blue: 1, Pink: 2 }), hatSend(HAT, 10)]);
  });

  it('drain pushes everything dirty now, without waiting for the window', async () => {
    const { pusher, sent } = setup();
    for (let owner = 1; owner <= 250; owner++) pusher.markDirty(event, hat(owner), NOW);
    expect(await pusher.drain(5_000)).toEqual({ left: 0 });
    expect(sent).toHaveLength(251);
  });

  it('drain starts no send after maxMs, and what it did not send goes out on the normal window', async () => {
    const { pusher, sent } = setup({
      topicSend: vi.fn(async (args: Sent) => {
        await new Promise((r) => setTimeout(r, 100));
        sent.push(args);
      }),
    });
    for (let owner = 1; owner <= 250; owner++) pusher.markDirty(event, hat(owner), NOW);
    let done = false;
    const drained = pusher.drain(1_000).then((r) => ((done = true), r));
    // 3 sends every 100ms: by 1s, 30 are done and the in-flight ones finish with them.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
    const { left } = await drained;
    expect(sent).toHaveLength(30);
    expect(left).toBe(251 - 30);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 20_000);
    expect(sent).toHaveLength(251);
  });

  it('drain holds a flush the timer already started to its deadline', async () => {
    const { pusher, sent } = setup({
      topicSend: vi.fn(async (args: Sent) => {
        await new Promise((r) => setTimeout(r, 100));
        sent.push(args);
      }),
    });
    for (let owner = 1; owner <= 250; owner++) pusher.markDirty(event, hat(owner), NOW);
    // The window's flush starts its 200 sends, 3 every 100ms.
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    let done = false;
    const drained = pusher.drain(500).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(true);
    // 5 rounds of 3 inside the deadline, not the timer flush's 200.
    expect(sent).toHaveLength(15);
    expect((await drained).left).toBe(251 - 15);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 20_000);
    expect(sent).toHaveLength(251);
  });

  it('drain waits for a timer flush that took everything, to its deadline', async () => {
    const { pusher, sent } = setup({
      topicSend: vi.fn(async (args: Sent) => {
        await new Promise((r) => setTimeout(r, 100));
        sent.push(args);
      }),
    });
    // Fits one flush: once it starts, nothing is left dirty for the drain's own loop.
    for (let owner = 1; owner <= 150; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS);
    expect(pusher.pending()).toBe(0);
    let done = false;
    const drained = pusher.drain(500).then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(sent).toHaveLength(15);
    // What the deadline stopped is dirty again, and reported.
    expect((await drained).left).toBe(151 - 15);
  });

  it('a send that fails after the breaker opened does not open it again', async () => {
    let call = 0;
    const { pusher } = setup({
      topicSend: vi.fn(async () => {
        const n = call++;
        // Failures spread out (never 2 in a row) open it on the 4th, at call 9; calls 10 and 11 are
        // already in flight, and fail a second later.
        await new Promise((r) => setTimeout(r, n >= 10 ? 1_000 : 10));
        if (n % 3 === 0 || n >= 10) throw new Error('timeout');
      }),
    });
    for (let owner = 1; owner <= 50; owner++) pusher.markDirty(event, hat(owner), NOW);
    await vi.advanceTimersByTimeAsync(PUSH_WINDOW_MS + 100);
    expect(pusher.isOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(call).toBe(12);
    // Opened at about +1040ms; a re-open by the late failures would hold it to about +62040ms.
    await vi.advanceTimersByTimeAsync(BREAKER_COOL_OFF_MS - 2_100 + 500);
    expect(pusher.isOpen()).toBe(false);
  });

  it('drain stops when awards mark faster than it sends, even on a frozen clock', async () => {
    let owner = 1_000;
    const { pusher } = setup({
      // Each send marks a hat nobody has marked yet, so the set does not shrink. Bounded, so a drain
      // that ignores the stall still ends, and fails on the count instead of hanging.
      topicSend: vi.fn(async () => {
        if (owner < 1_000 + 10 * MAX_SENDS_PER_FLUSH) pusher.markDirty(event, hat(owner++), NOW);
      }),
    });
    for (let o = 1; o <= 250; o++) pusher.markDirty(event, hat(o), NOW);
    // No timers are advanced, so the fake clock never reaches the deadline.
    const { left } = await pusher.drain(5_000);
    expect(left).toBeGreaterThan(0);
    expect(owner).toBe(1_000 + MAX_SENDS_PER_FLUSH);
  });
});

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
