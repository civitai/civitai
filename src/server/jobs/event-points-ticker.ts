import { sleep } from '~/server/utils/concurrency-helpers';
import { loadEvents } from '~/server/events/load-events';
import { isEventPointsEnabled, isEventPointsEnabledSync } from '~/server/events/points/enabled';
import type { TickerEvent } from '~/server/events/points/ticker';
import { runEventPointsTicker, tickEventPoints } from '~/server/events/points/ticker';
import { createJob } from '~/server/jobs/job';

// The referee keeps correcting totals until scoring finalizes; its last corrections still go out.
const TICK_AFTER_FINAL_MS = 60 * 60 * 1000;

// From the start, never the preview: topics are named by the public event name and anyone can
// subscribe, while the preview's reads are gated to previewers. Previewers still read live totals
// on each open.

export function getTickerEvents(
  events: {
    name: string;
    startDate: Date;
    endDate: Date;
    teams: readonly string[];
    scoring?: { finalizeAfterMs: number };
  }[],
  now: Date
): TickerEvent[] {
  return events
    .filter(
      (e) =>
        !!e.scoring &&
        e.startDate <= now &&
        e.endDate.getTime() + e.scoring.finalizeAfterMs + TICK_AFTER_FINAL_MS >= now.getTime()
    )
    .map(({ name, startDate, endDate, teams }) => ({ name, startDate, endDate, teams }));
}

// Pushes live hat and team totals over signals. The scheduler's finest grain is a minute and the
// screens want ~5s freshness, so each run ticks every 5s for 55s (see runEventPointsTicker). The
// 90s lock keeps a slow run from overlapping the next minute's.
export const eventPointsTicker = createJob(
  'event-points-ticker',
  '* * * * *',
  async (ctx) => {
    if (!(await isEventPointsEnabled())) return { ticks: 0, stopped: false, disabled: true };
    return runEventPointsTicker(async () => getTickerEvents(await loadEvents(), new Date()), {
      now: Date.now,
      sleep: async (ms) => {
        await sleep(ms);
      },
      // Switched off mid-run, the run stops at the next tick rather than sending for the rest of it.
      isCanceled: () => ctx.status === 'canceled' || !isEventPointsEnabledSync(),
      tick: (event, deadline) => tickEventPoints(event, undefined, { deadline }),
    });
  },
  { lockExpiration: 90 }
);
