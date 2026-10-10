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
      scoring: {},
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
});
