import { SignalMessages } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { signalClient } from '~/utils/signal-client';
import { eventHatTopic, eventTeamsTopic, hatField, hatTopicId } from './keys';
import { drainChangedHats, getHatPoints, getTeamPoints } from './read';
import type { EventHat } from './types';

// Most hats one tick pushes per event. Hats past it stay in the changed set for the next tick.
// Until signals can say which topics have subscribers, every changed hat is a POST, so this bounds
// the load a busy minute puts on the signals service.
export const MAX_HAT_SENDS_PER_TICK = 200;
export const TICK_MS = 5_000;
// The scheduler fires once a minute; the run ticks until here, so it ends before the next one.
// Its trigger request is only abandoned about an hour in (see delete-old-training-data.ts), so a
// 55s run needs no keepLockOnDisconnect.
export const TICK_WINDOW_MS = 55_000;

export type TickerEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
};
type Hat = Omit<EventHat, 'team'>;

// Narrows a tick's hats to those someone is watching. Identity until the signals service exposes
// its subscriber set (ClickUp 868mfm4pp); that change adds the lookup behind its own flag.
export async function selectWatchedHats(_event: TickerEvent, hats: Hat[]) {
  return hats;
}

export type TickDeps = {
  drainChangedHats: typeof drainChangedHats;
  selectWatchedHats: typeof selectWatchedHats;
  getHatPoints: typeof getHatPoints;
  getTeamPoints: typeof getTeamPoints;
  topicSend: typeof signalClient.topicSend;
};
const defaultDeps: TickDeps = {
  drainChangedHats,
  selectWatchedHats,
  getHatPoints,
  getTeamPoints,
  topicSend: (args) => signalClient.topicSend(args),
};

// The signals client's lane and circuit breaker are shared by every push on the pod (chat, buzz,
// generation); the breaker opens at 10 timeouts in 60s (SIGNALS_CIRCUIT_TRIP_THRESHOLD). A tick
// sends at most SEND_CONCURRENCY at once and starts nothing after FAILURES_TO_STOP failures, and a
// tick that stops ends the whole run: one run can time out at most
// SEND_CONCURRENCY + FAILURES_TO_STOP - 1 = 4 calls, so two runs a minute apart stay under 10.
export const SEND_CONCURRENCY = 3;
export const FAILURES_TO_STOP = 2;

type Send = Parameters<TickDeps['topicSend']>[0];

// One tick for one event: push the team totals, then the new total of every hat that moved. A
// failed or skipped send is dropped, never re-queued, so a signals outage cannot grow the changed
// set; the next move of that hat, or the screen's next read, catches it up. A failed read loses the
// drained hats the same way.
export async function tickEventPoints(
  event: TickerEvent,
  deps: TickDeps = defaultDeps,
  now = new Date()
) {
  const drained = await deps.drainChangedHats(event, MAX_HAT_SENDS_PER_TICK);
  if (!drained.length) return { drained: 0, sent: 0, failed: 0, dropped: 0, stopped: false };
  const hats = await deps.selectWatchedHats(event, drained);
  // Once the event has ended the page names a winner from the settled standings; live team totals
  // must not reach it.
  const ended = event.endDate <= now;
  const [points, teams] = await Promise.all([
    hats.length ? deps.getHatPoints(event, hats) : ({} as Record<string, number>),
    // Any drained hat moved its team's total, watched or not.
    ended ? null : deps.getTeamPoints(event),
  ]);
  const queue: Send[] = [
    ...(teams
      ? [
          {
            topic: eventTeamsTopic(event.name),
            target: SignalMessages.EventPointsTeams,
            data: { event: event.name, teams },
          },
        ]
      : []),
    ...hats.map((hat) => {
      const topicId = hatTopicId(hat);
      return {
        topic: eventHatTopic(event.name, topicId),
        target: SignalMessages.EventPointsHat,
        data: { event: event.name, topicId, points: points[hatField(hat)] ?? 0 },
      };
    }),
  ];
  let next = 0;
  let sent = 0;
  let failed = 0;
  const worker = async () => {
    while (failed < FAILURES_TO_STOP && next < queue.length) {
      const send = queue[next++];
      try {
        await deps.topicSend(send);
        sent++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
  const dropped = queue.length - sent - failed;
  if (failed)
    logToAxiom({
      type: 'warning',
      name: 'event-points-ticker',
      event: event.name,
      message: 'signals sends failed',
      sent,
      failed,
      dropped,
    }).catch(() => undefined);
  return { drained: drained.length, sent, failed, dropped, stopped: failed >= FAILURES_TO_STOP };
}

type TickerRunDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isCanceled: () => boolean;
  tick: (event: TickerEvent) => Promise<{ stopped?: boolean } | void>;
};

// One scheduler run: a tick every TICK_MS until TICK_WINDOW_MS has passed. A tick that runs long
// shortens the wait before the next, never stacks two. One event's failure skips that event for
// this tick only; a tick that stopped on signals failures ends the run (see SEND_CONCURRENCY).
export async function runEventPointsTicker(
  getEvents: () => Promise<TickerEvent[]> | TickerEvent[],
  { now, sleep, isCanceled, tick }: TickerRunDeps
) {
  const start = now();
  let ticks = 0;
  let stopped = false;
  while (!isCanceled() && !stopped) {
    const tickStart = now();
    for (const event of await getEvents()) {
      try {
        if ((await tick(event))?.stopped) {
          stopped = true;
          break;
        }
      } catch (error) {
        logToAxiom({
          type: 'error',
          name: 'event-points-ticker',
          event: event.name,
          message: (error as Error).message,
        }).catch(() => undefined);
      }
    }
    ticks++;
    if (stopped) break;
    const next = tickStart + TICK_MS;
    if (Math.max(next, now()) - start >= TICK_WINDOW_MS) break;
    const wait = next - now();
    if (wait > 0) await sleep(wait);
  }
  return { ticks, stopped };
}
