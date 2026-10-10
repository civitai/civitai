import { SignalMessages } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import { signalClient } from '~/utils/signal-client';
import { isEventPointsEnabledSync } from './enabled';
import {
  eventHatTopic,
  eventPointKeys,
  eventPointSeason,
  hatField,
  seasonHatTopicId,
  seasonTeamsTopic,
  seasonTeamsTopicId,
  type EventPointSeason,
} from './keys';
import { getHatTotals, getTeamPoints } from './read';
import { readWatched } from './watch';
import type { EventHat } from './types';

// Awards inside one window collapse into one push per topic.
export const PUSH_WINDOW_MS = 1_000;
// Most sends one flush starts, the same cap the ticker had per tick. Until signals can say which
// topics have subscribers, every dirty hat is a POST, so this bounds what a burst of awards puts on
// the signals service; the rest stay dirty for the next window.
export const MAX_SENDS_PER_FLUSH = 200;
// Most hats one event keeps dirty. A mark past it is dropped; the screen's next read catches it up.
export const MAX_DIRTY_HATS = 10_000;
// A load-shed for this pusher only, on top of the signals client's own breaker, which is shared by
// every push on the pod (chat, buzz, generation) and opens at 10 timeouts in 60s. This one stops
// pushing on this server for BREAKER_COOL_OFF_MS after FAILURES_TO_OPEN failures in a row, or
// FAILURES_PER_COOL_OFF failures of any kind within one cool-off, so a partial outage is bounded too.
// With SEND_CONCURRENCY sends in flight, it puts at most
// FAILURES_PER_COOL_OFF + SEND_CONCURRENCY - 1 = 6 failures into any 60s.
export const SEND_CONCURRENCY = 3;
export const FAILURES_TO_OPEN = 2;
export const FAILURES_PER_COOL_OFF = 4;
export const BREAKER_COOL_OFF_MS = 60_000;
// How long the referee waits for its corrections to go out before its job carries on.
export const REFEREE_DRAIN_MS = 5_000;

export type PushEvent = {
  name: string;
  previewFrom?: Date;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
};
type Hat = Omit<EventHat, 'team'>;

// Narrows a flush to the topics someone has on screen (watch.ts), with one interest-set read per
// event. Fails closed: if the read fails nothing is pushed, since pushing everything would restore
// the unwatched fan-out exactly while Redis is struggling; screens catch up on their next read.
export async function selectWatched(
  event: PushEvent,
  hats: Hat[],
  teams: boolean,
  season: EventPointSeason
) {
  const hatId = (hat: Hat) => seasonHatTopicId(event.name, hat, season);
  const teamsId = seasonTeamsTopicId(event.name, season);
  const topics = [...hats.map(hatId), ...(teams ? [teamsId] : [])];
  try {
    const watched = await readWatched(event.name, topics, Date.now());
    return {
      hats: hats.filter((hat) => watched.has(hatId(hat))),
      teams: teams && watched.has(teamsId),
    };
  } catch (error) {
    logPush('error', event.name, {
      message: 'interest set read failed',
      error: (error as Error).message,
    });
    return { hats: [] as Hat[], teams: false };
  }
}

// Every server that granted points has the team totals dirty, and they are the same totals, read
// from Redis. A lease for one push window lets one server send them; the others keep them dirty and
// try the next window, so a later grant is still sent. Fails closed, like selectWatched.
let leaseErrorLogged = false;
export async function claimTeamsPush(event: PushEvent) {
  try {
    const leased = await sysRedis.set(eventPointKeys(event.name).teamsPushLease, '1', {
      NX: true,
      PX: PUSH_WINDOW_MS,
    });
    // Null when another server holds it.
    leaseErrorLogged = false;
    return !!leased;
  } catch (error) {
    // Logged once until the lease works again: every granting server retries it every window.
    if (!leaseErrorLogged)
      logPush('error', event.name, {
        message: 'team push lease failed',
        error: (error as Error).message,
      });
    leaseErrorLogged = true;
    return false;
  }
}

export type PushDeps = {
  selectWatched: typeof selectWatched;
  claimTeamsPush: typeof claimTeamsPush;
  getHatTotals: typeof getHatTotals;
  getTeamPoints: typeof getTeamPoints;
  topicSend: typeof signalClient.topicSend;
  // The engine's kill switch: off, nothing is marked and nothing dirty is sent.
  isEnabled: () => boolean;
};

type Send = Parameters<PushDeps['topicSend']>[0];
// A send, and how to mark its topic dirty again if it is not started.
type Queued = { send: Send; putBack: () => void };
// `teamsLostAt`: when this server first lost the team push lease since its last mark.
type Dirty = { event: PushEvent; hats: Map<string, Hat>; teams: boolean; teamsLostAt?: number };

// Pushes live totals over signals as they change: an award marks its hat and team dirty, and one
// flush per window reads their totals and sends them. In memory and per server; a push that fails or
// is dropped is caught up by the topic's next change, or by the screen's next read.
export function createEventPointsPusher(deps: PushDeps) {
  const dirty = new Map<string, Dirty>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let failuresInARow = 0;
  // When each failure inside the last cool-off happened.
  let failureTimes: number[] = [];
  let openUntil = 0;
  // While a drain runs, its deadline: no send starts after it, in the drain's flushes or in a flush
  // the timer had already started.
  let sendBy = Infinity;
  // The cap's drops are logged once per server, not once per mark.
  let capLogged = false;

  const isOpen = () => Date.now() < openUntil;

  function schedule() {
    if (timer || flushing || !dirty.size) return;
    timer = setTimeout(() => void flush(), PUSH_WINDOW_MS);
    timer.unref?.();
  }

  function entryFor(event: PushEvent) {
    let entry = dirty.get(event.name);
    if (!entry) {
      entry = { event, hats: new Map(), teams: false };
      dirty.set(event.name, entry);
    }
    return entry;
  }

  // Marks a hat, and its team, whose total just moved; false when it was not marked. From the preview
  // on: a flush pushes the season it runs in, and the preview's topics are unguessable (keys.ts).
  function markDirty(event: PushEvent, hat: Hat, time: Date) {
    if (time < (event.previewFrom ?? event.startDate) || isOpen() || !deps.isEnabled())
      return false;
    const entry = entryFor(event);
    const field = hatField(hat);
    if (entry.hats.size >= MAX_DIRTY_HATS && !entry.hats.has(field)) {
      if (!capLogged)
        logPush('warning', event.name, { message: 'dirty hats at cap, marks dropped' });
      capLogged = true;
      return false;
    }
    entry.hats.set(field, hat);
    entry.teams = true;
    entry.teamsLostAt = undefined;
    schedule();
    return true;
  }

  // Takes up to `budget` sends' worth of dirty topics, reads their totals and builds the sends.
  async function collect(budget: number) {
    const now = new Date();
    const queue: Queued[] = [];
    for (const [name, entry] of [...dirty]) {
      if (queue.length >= budget) break;
      const { event } = entry;
      // Totals are read for the season of `now` (read.ts), so the topics are named for it too.
      const season = eventPointSeason(event.startDate, now);
      // Once the event has ended the page names a winner from the settled standings; live team
      // totals must not reach it.
      const teams = entry.teams && event.endDate > now;
      const { teamsLostAt } = entry;
      entry.teams = false;
      entry.teamsLostAt = undefined;
      const room = budget - queue.length - (teams ? 1 : 0);
      const taken: Hat[] = [];
      for (const [field, hat] of entry.hats) {
        if (taken.length >= room) break;
        taken.push(hat);
        entry.hats.delete(field);
      }
      if (!entry.hats.size) dirty.delete(name);
      try {
        const { hats: watchedHats, teams: watchedTeams } =
          taken.length || teams
            ? await deps.selectWatched(event, taken, teams, season)
            : { hats: [] as Hat[], teams: false };
        // Before the claim: the second-loss test below compares this to the end of the first loss.
        const claimFrom = Date.now();
        const pushTeams = watchedTeams && (await deps.claimTeamsPush(event));
        if (watchedTeams && !pushTeams) {
          // Lost to another server. Try once more in a later window: by then this lease has lapsed,
          // so a second loss means its holder claimed after this server's last mark, and it reads
          // and sends the totals this server would. Without that, every server that granted in a
          // burst sends the same totals in turn, one a second.
          // Stamped after the first loss returned, compared to before this claim was sent: a full
          // window between them however slow either round trip was.
          const secondLoss = teamsLostAt !== undefined && claimFrom - teamsLostAt >= PUSH_WINDOW_MS;
          // A mark during this flush is newer than both leases, so it keeps its own try.
          const entryNow = secondLoss ? undefined : entryFor(event);
          if (entryNow && !entryNow.teams) {
            entryNow.teams = true;
            entryNow.teamsLostAt = teamsLostAt ?? Date.now();
          }
        }
        const [hatTotals, totals] = await Promise.all([
          watchedHats.length ? deps.getHatTotals(event, watchedHats, now) : null,
          // Read as of now, after the claim: the losers drop their teams trusting this read is
          // later than their grants.
          pushTeams ? deps.getTeamPoints(event, new Date()) : null,
        ]);
        if (totals)
          queue.push({
            send: {
              topic: seasonTeamsTopic(name, seasonTeamsTopicId(name, season)),
              target: SignalMessages.EventPointsTeams,
              data: { event: name, teams: totals },
            },
            putBack: () => (entryFor(event).teams = true),
          });
        for (const hat of watchedHats) {
          const topicId = seasonHatTopicId(name, hat, season);
          const field = hatField(hat);
          queue.push({
            send: {
              topic: eventHatTopic(name, topicId),
              target: SignalMessages.EventPointsHat,
              data: {
                event: name,
                topicId,
                points: hatTotals?.points[field] ?? 0,
                counts: hatTotals?.counts?.[field],
              },
            },
            putBack: () => void entryFor(event).hats.set(hatField(hat), hat),
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
    failureTimes = [];
    // Dropped, not kept: a signals outage must not grow the set.
    dirty.clear();
    clearTimer();
  }

  function recordFailure() {
    const now = Date.now();
    failureTimes = failureTimes.filter((t) => now - t < BREAKER_COOL_OFF_MS);
    failureTimes.push(now);
    if (++failuresInARow >= FAILURES_TO_OPEN || failureTimes.length >= FAILURES_PER_COOL_OFF)
      open();
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  // Starts no send after `sendBy`; what it did not start is dirty again for the next window.
  async function flushOnce() {
    clearTimer();
    if (isOpen() || !deps.isEnabled()) return dirty.clear();
    const queue = await collect(MAX_SENDS_PER_FLUSH);
    let next = 0;
    let sent = 0;
    let failed = 0;
    const worker = async () => {
      while (next < queue.length && !isOpen() && Date.now() < sendBy) {
        const { send } = queue[next++];
        try {
          await deps.topicSend(send);
          sent++;
          failuresInARow = 0;
        } catch {
          failed++;
          // A send still in flight when the breaker opened must not open it again.
          if (!isOpen()) recordFailure();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, worker));
    if (!isOpen()) for (const { putBack } of queue.slice(next)) putBack();
    if (failed)
      logPush('warning', undefined, {
        message: isOpen() ? 'signals sends failed, pushing paused' : 'signals sends failed',
        sent,
        failed,
        dropped: isOpen() ? queue.length - sent - failed : 0,
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

  // Team totals waiting on another server's lease are not counted: that server is sending them.
  const pending = () =>
    [...dirty.values()].reduce(
      (n, d) => n + d.hats.size + (d.teams && d.teamsLostAt === undefined ? 1 : 0),
      0
    );

  // Flushes now, and again until nothing is dirty or `maxMs` has passed, for a job that must get its
  // pushes out before it ends. No send starts after `maxMs`, including in a flush the timer had
  // already started, so it overruns by the sends in flight and a flush's reads. It also stops once a
  // flush leaves no fewer dirty topics than it found, as when awards mark faster than it sends. What
  // is left goes out on the normal window.
  async function drain(maxMs: number) {
    const deadline = Date.now() + maxMs;
    sendBy = Math.min(sendBy, deadline);
    try {
      while (dirty.size && Date.now() < deadline) {
        await flushing;
        const before = pending();
        await flush();
        if (pending() >= before) break;
      }
      // A flush the timer started may still be running; it stops at the deadline too.
      await flushing;
    } finally {
      sendBy = Infinity;
    }
    const left = pending();
    if (left) logPush('warning', undefined, { message: 'drain timed out', left });
    return { left };
  }

  return { markDirty, flush, drain, isOpen, pending, dirtyCount: () => dirty.size };
}

function logPush(type: 'warning' | 'error', event: string | undefined, extra: object) {
  logToAxiom({ type, name: 'event-points-push', event, ...extra }).catch(() => undefined);
}

let pusher: ReturnType<typeof createEventPointsPusher> | undefined;
function getPusher() {
  pusher ??= createEventPointsPusher({
    selectWatched,
    claimTeamsPush,
    getHatTotals,
    getTeamPoints,
    topicSend: (args) => signalClient.topicSend(args),
    isEnabled: isEventPointsEnabledSync,
  });
  return pusher;
}

export const markEventPointsDirty = (event: PushEvent, hat: Hat, time: Date) =>
  getPusher().markDirty(event, hat, time);
export const drainEventPointsPush = (maxMs = REFEREE_DRAIN_MS) => getPusher().drain(maxMs);
