import { SignalMessages } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { signalClient } from '~/utils/signal-client';
import { eventHatTopic, eventTeamsTopic, hatField, hatTopicId } from './keys';
import { getHatPoints, getTeamPoints } from './read';
import type { EventHat } from './types';

// Awards inside one window collapse into one push per topic.
export const PUSH_WINDOW_MS = 1_000;
// Most sends one flush starts. Until signals can say which topics have subscribers, every dirty hat
// is a POST, so this bounds what a burst of awards puts on the signals service; the rest stay dirty
// for the next window.
export const MAX_SENDS_PER_FLUSH = 200;
// The signals client's lane and circuit breaker are shared by every push on the pod (chat, buzz,
// generation); its breaker opens at 10 timeouts in 60s. This one opens first: at most
// SEND_CONCURRENCY sends are in flight, and FAILURES_TO_OPEN failures in a row stop pushing on this
// server for BREAKER_COOL_OFF_MS, so a signals outage costs it a handful of timeouts a minute.
export const SEND_CONCURRENCY = 3;
export const FAILURES_TO_OPEN = 2;
export const BREAKER_COOL_OFF_MS = 60_000;
// How long the referee waits for its corrections to go out before its job carries on.
export const REFEREE_DRAIN_MS = 5_000;

export type PushEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
};
type Hat = Omit<EventHat, 'team'>;

// Narrows a flush's hats to those someone is watching. Identity until the interest set lands.
export async function selectWatchedHats(_event: PushEvent, hats: Hat[]) {
  return hats;
}
// Whether anyone is watching the event's team standings. Always, until the interest set lands.
export async function selectWatchedTeams(_event: PushEvent) {
  return true;
}

export type PushDeps = {
  selectWatchedHats: typeof selectWatchedHats;
  selectWatchedTeams: typeof selectWatchedTeams;
  getHatPoints: typeof getHatPoints;
  getTeamPoints: typeof getTeamPoints;
  topicSend: typeof signalClient.topicSend;
};

type Send = Parameters<PushDeps['topicSend']>[0];
type Dirty = { event: PushEvent; hats: Map<string, Hat>; teams: boolean };

// Pushes live totals over signals as they change: an award marks its hat and team dirty, and one
// flush per window reads their totals and sends them. In memory and per server; a push that fails or
// is dropped is caught up by the topic's next change, or by the screen's next read.
export function createEventPointsPusher(deps: PushDeps) {
  const dirty = new Map<string, Dirty>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let failuresInARow = 0;
  let openUntil = 0;

  const isOpen = () => Date.now() < openUntil;

  function schedule() {
    if (timer || flushing || !dirty.size) return;
    timer = setTimeout(() => void flush(), PUSH_WINDOW_MS);
    timer.unref?.();
  }

  // Marks a hat, and its team, whose total just moved. Preview totals are never pushed: topics are
  // named by the public event name, and anyone can subscribe to them.
  function markDirty(event: PushEvent, hat: Hat, time: Date) {
    if (time < event.startDate || isOpen()) return;
    let entry = dirty.get(event.name);
    if (!entry) {
      entry = { event, hats: new Map(), teams: false };
      dirty.set(event.name, entry);
    }
    entry.hats.set(hatField(hat), hat);
    entry.teams = true;
    schedule();
  }

  // Takes up to `budget` sends' worth of dirty topics, reads their totals and builds the sends.
  async function collect(budget: number) {
    const now = new Date();
    const queue: Send[] = [];
    for (const [name, entry] of [...dirty]) {
      if (queue.length >= budget) break;
      const { event } = entry;
      // Once the event has ended the page names a winner from the settled standings; live team
      // totals must not reach it.
      const teams = entry.teams && event.endDate > now;
      entry.teams = false;
      const room = budget - queue.length - (teams ? 1 : 0);
      const taken = [...entry.hats.values()].slice(0, Math.max(0, room));
      for (const hat of taken) entry.hats.delete(hatField(hat));
      if (!entry.hats.size) dirty.delete(name);
      try {
        const [watchedHats, watchedTeams] = await Promise.all([
          taken.length ? deps.selectWatchedHats(event, taken) : ([] as Hat[]),
          teams ? deps.selectWatchedTeams(event) : false,
        ]);
        const [points, totals] = await Promise.all([
          watchedHats.length
            ? deps.getHatPoints(event, watchedHats, now)
            : ({} as Record<string, number>),
          watchedTeams ? deps.getTeamPoints(event, now) : null,
        ]);
        if (totals)
          queue.push({
            topic: eventTeamsTopic(name),
            target: SignalMessages.EventPointsTeams,
            data: { event: name, teams: totals },
          });
        for (const hat of watchedHats) {
          const topicId = hatTopicId(hat);
          queue.push({
            topic: eventHatTopic(name, topicId),
            target: SignalMessages.EventPointsHat,
            data: { event: name, topicId, points: points[hatField(hat)] ?? 0 },
          });
        }
      } catch (error) {
        // A failed read drops what it took, like a failed send.
        logPush('error', name, { message: (error as Error).message });
      }
    }
    return queue;
  }

  function open() {
    openUntil = Date.now() + BREAKER_COOL_OFF_MS;
    failuresInARow = 0;
    // Dropped, not kept: a signals outage must not grow the set.
    dirty.clear();
    clearTimer();
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  async function flushOnce() {
    clearTimer();
    if (isOpen()) return dirty.clear();
    const queue = await collect(MAX_SENDS_PER_FLUSH);
    let next = 0;
    let sent = 0;
    let failed = 0;
    const worker = async () => {
      while (next < queue.length && !isOpen()) {
        const send = queue[next++];
        try {
          await deps.topicSend(send);
          sent++;
          failuresInARow = 0;
        } catch {
          failed++;
          if (++failuresInARow >= FAILURES_TO_OPEN) open();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
    if (failed)
      logPush('warning', undefined, {
        message: isOpen() ? 'signals sends failed, pushing paused' : 'signals sends failed',
        sent,
        failed,
        dropped: queue.length - sent - failed,
      });
  }

  // One window's flush. Anything over the bound, or marked while it ran, waits for the next window.
  function flush() {
    flushing ??= flushOnce().finally(() => {
      flushing = undefined;
      schedule();
    });
    return flushing;
  }

  // Flushes now, and again until nothing is dirty or `maxMs` has passed, for a job that must get its
  // pushes out before it ends. What is left after `maxMs` goes out on the normal window.
  async function drain(maxMs: number) {
    const deadline = Date.now() + maxMs;
    while (dirty.size && Date.now() < deadline) {
      await flushing;
      await flush();
    }
    const left = [...dirty.values()].reduce((n, d) => n + d.hats.size + (d.teams ? 1 : 0), 0);
    if (left) logPush('warning', undefined, { message: 'drain timed out', left });
    return { left };
  }

  return { markDirty, flush, drain, isOpen, dirtyCount: () => dirty.size };
}

function logPush(type: 'warning' | 'error', event: string | undefined, extra: object) {
  logToAxiom({ type, name: 'event-points-push', event, ...extra }).catch(() => undefined);
}

let pusher: ReturnType<typeof createEventPointsPusher> | undefined;
function getPusher() {
  pusher ??= createEventPointsPusher({
    selectWatchedHats,
    selectWatchedTeams,
    getHatPoints,
    getTeamPoints,
    topicSend: (args) => signalClient.topicSend(args),
  });
  return pusher;
}

export const markEventPointsDirty = (event: PushEvent, hat: Hat, time: Date) =>
  getPusher().markDirty(event, hat, time);
export const drainEventPointsPush = (maxMs = REFEREE_DRAIN_MS) => getPusher().drain(maxMs);
