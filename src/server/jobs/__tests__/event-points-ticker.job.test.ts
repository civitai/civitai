import { describe, expect, it, vi } from 'vitest';

/**
 * The job's wiring of the ticker: the events it loads, and that each tick gets the run's deadline
 * (without it a slow tick can carry the run past its lock). The loop and the tick have their own
 * tests in src/server/events/points/__tests__/ticker.test.ts.
 */
const { ticker, events } = vi.hoisted(() => ({
  ticker: { runEventPointsTicker: vi.fn(), tickEventPoints: vi.fn() },
  events: [
    {
      name: 'birthday2026',
      startDate: new Date('2000-01-01'),
      endDate: new Date('2999-01-01'),
      teams: ['Blue'],
      scoring: { finalizeAfterMs: 0 },
    },
  ],
}));
vi.mock('~/server/events/points/ticker', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...ticker,
}));
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => events }));

const { eventPointsTicker } = await import('~/server/jobs/event-points-ticker');

describe('event-points-ticker job', () => {
  it("ticks the loaded events, handing each tick the run's deadline", async () => {
    ticker.runEventPointsTicker.mockImplementation(async (getEvents, deps) => {
      const [event] = await getEvents();
      await deps.tick(event, 123_456);
      return { ticks: 1 };
    });
    await eventPointsTicker.run().result;
    expect(ticker.tickEventPoints).toHaveBeenCalledWith(
      {
        name: 'birthday2026',
        startDate: events[0].startDate,
        endDate: events[0].endDate,
        teams: ['Blue'],
      },
      undefined,
      { deadline: 123_456 }
    );
  });

  // The loop's own tests inject these; here they are the job's, so a wrong one would stop or stall
  // the live ticker with every other test green.
  it('runs the loop on the real clock and timer, and reports a canceled job as canceled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const canceled: boolean[] = [];
    let clockSkew = Infinity;
    let slept = 0;
    ticker.runEventPointsTicker.mockImplementation(async (_getEvents, deps) => {
      canceled.push(deps.isCanceled());
      clockSkew = Math.abs(deps.now() - Date.now());
      const before = Date.now();
      await deps.sleep(30);
      slept = Date.now() - before;
      await gate;
      canceled.push(deps.isCanceled());
      return { ticks: 0 };
    });

    const run = eventPointsTicker.run();
    await vi.waitFor(() => expect(slept).toBeGreaterThan(0));
    await run.cancel();
    release();
    await run.result;

    expect(canceled).toEqual([false, true]);
    expect(clockSkew).toBeLessThan(1000);
    expect(slept).toBeGreaterThanOrEqual(25);
  });
});
