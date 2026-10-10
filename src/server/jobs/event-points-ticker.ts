import { loadEvents } from '~/server/events/load-events';
import type { TickerEvent } from '~/server/events/points/ticker';
import { runEventPointsTicker, tickEventPoints } from '~/server/events/points/ticker';
import { createJob } from '~/server/jobs/job';

// The referee keeps correcting totals for a while after the end; their pushes still go out.
const TICK_AFTER_END_MS = 2 * 24 * 60 * 60 * 1000;

// From the start, never the preview: topics are named by the public event name and anyone can
// subscribe, while the preview's reads are gated to previewers. Previewers still read live totals
// on each open.

export function getTickerEvents(
  events: {
    name: string;
    startDate: Date;
    endDate: Date;
    teams: readonly string[];
    scoring?: unknown;
  }[],
  now: Date
): TickerEvent[] {
  return events
    .filter(
      (e) =>
        !!e.scoring &&
        e.startDate <= now &&
        e.endDate.getTime() + TICK_AFTER_END_MS >= now.getTime()
    )
    .map(({ name, startDate, teams }) => ({ name, startDate, teams }));
}

// Pushes live hat and team totals over signals. The scheduler's finest grain is a minute and the
// screens want ~5s freshness, so each run ticks every 5s for 55s (see runEventPointsTicker). The
// 90s lock keeps a slow run from overlapping the next minute's.
export const eventPointsTicker = createJob(
  'event-points-ticker',
  '* * * * *',
  async (ctx) => {
    return runEventPointsTicker(async () => getTickerEvents(await loadEvents(), new Date()), {
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      isCanceled: () => ctx.status === 'canceled',
      tick: (event) => tickEventPoints(event),
    });
  },
  { lockExpiration: 90 }
);
