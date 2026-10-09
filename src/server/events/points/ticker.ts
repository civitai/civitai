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
export const TICK_WINDOW_MS = 55_000;

export type TickerEvent = { name: string; startDate: Date; teams: readonly string[] };
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

// One tick for one event: push the new total of every hat that moved, then the team totals. A
// failed send is dropped, never re-queued, so a signals outage cannot grow the changed set; the
// next move of that hat, or the client's own refetch, catches the screen up.
export async function tickEventPoints(event: TickerEvent, deps: TickDeps = defaultDeps) {
  const drained = await deps.drainChangedHats(event, MAX_HAT_SENDS_PER_TICK);
  if (!drained.length) return { drained: 0, sent: 0, failed: 0 };
  const hats = await deps.selectWatchedHats(event, drained);
  const points = hats.length ? await deps.getHatPoints(event, hats) : {};
  const sends = hats.map((hat) => {
    const topicId = hatTopicId(hat);
    return deps.topicSend({
      topic: eventHatTopic(event.name, topicId),
      target: SignalMessages.EventPointsHat,
      data: { event: event.name, topicId, points: points[hatField(hat)] ?? 0 },
    });
  });
  // Any drained hat moved its team's total, watched or not.
  const teams = await deps.getTeamPoints(event);
  sends.push(
    deps.topicSend({
      topic: eventTeamsTopic(event.name),
      target: SignalMessages.EventPointsTeams,
      data: { event: event.name, teams },
    })
  );
  const results = await Promise.allSettled(sends);
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { drained: drained.length, sent: results.length - failed, failed };
}

type TickerRunDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  isCanceled: () => boolean;
  tick: (event: TickerEvent) => Promise<unknown>;
};

// One scheduler run: a tick every TICK_MS until TICK_WINDOW_MS has passed. A tick that runs long
// shortens the wait before the next, never stacks two. One event's failure skips that event for
// this tick only.
export async function runEventPointsTicker(
  getEvents: () => Promise<TickerEvent[]> | TickerEvent[],
  { now, sleep, isCanceled, tick }: TickerRunDeps
) {
  const start = now();
  let ticks = 0;
  while (!isCanceled()) {
    const tickStart = now();
    for (const event of await getEvents()) {
      try {
        await tick(event);
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
    const next = tickStart + TICK_MS;
    if (Math.max(next, now()) - start >= TICK_WINDOW_MS) break;
    const wait = next - now();
    if (wait > 0) await sleep(wait);
  }
  return { ticks };
}
