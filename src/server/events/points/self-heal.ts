import { env } from '~/env/server';
import { getEventScoringPhase } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import { eventPointSeason } from '~/server/events/points/keys';
import { runEventPointsReferee } from '~/server/events/points/referee';
import { syncEventHats } from '~/server/events/points/sync';
import { acquireJobLock, type JobLock } from '~/server/jobs/job-lock';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

// The engine runs the hourly job's hat reconcile and settle itself when the switch turns on, or when
// it finds a scored event with no hat map or no count base: the run-jobs webhook only answers the
// in-cluster scheduler, so nobody can run that job by hand at switch-on.
export type SelfHealReason = 'switch-on' | 'empty-map' | 'missing-count-base';
export type SelfHealOutcome = 'busy' | 'off' | 'unknown' | 'cooldown' | 'locked' | 'ran' | 'failed';

// The job whose lock the heal takes: the referee's settle stages its bases under shared keys, so it
// must never run beside the hourly job (or another pod's heal). Its lock expiration, too.
export const SETTLE_JOB = 'event-engine-leaderboard-update';
export const SETTLE_LOCK_S = 15 * 60;
// One heal per event per window, across every pod, whatever happened to the last one: a genuinely
// empty event (no hats placed), or one the referee has nothing to settle for yet, would otherwise
// heal on every reload. A flip has its own window, so an earlier repair cannot swallow it.
export const SELF_HEAL_COOLDOWN_S = 15 * 60;
export const selfHealCooldownKey = (event: string, reason: SelfHealReason) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:self-heal-cooldown:${
    reason === 'switch-on' ? 'switch-on' : 'repair'
  }` as const;
// A flip that finds the settle lock held tries again this often, for as long as the lock can be held:
// nothing else asks again, and the holder may be an hourly run that read the switch as off.
export const SWITCH_ON_RETRY_MS = 60 * 1000;
// One past the lock's cap, which lands a few seconds after it (the lock counts down in 8 s ticks).
export const SWITCH_ON_RETRIES = Math.ceil((SETTLE_LOCK_S * 1000) / SWITCH_ON_RETRY_MS) + 1;

type HealedEvent = Awaited<ReturnType<typeof loadEvents>>[number];

export type SelfHealDeps = {
  isEnabled: () => Promise<boolean>;
  redis: Pick<typeof sysRedis, 'set'>;
  acquireLock: (name: string, lockExpiration: number) => Promise<JobLock | null>;
  loadEvent: (name: string) => Promise<HealedEvent | undefined>;
  syncEventHats: (now: Date) => Promise<{ event: string; set: number; removed: number }[]>;
  getScoringPhase: (event: HealedEvent, now: Date) => Promise<unknown>;
  runReferee: typeof runEventPointsReferee;
  log: (entry: Record<string, unknown>) => void;
  now: () => Date;
  pod: string | undefined;
  retryLater: (fn: () => void, ms: number) => void;
};

export function createEventPointsSelfHeal(deps: SelfHealDeps) {
  // A heal already running on this pod: a slow settle must not stack a second one behind it.
  const inFlight = new Set<string>();

  // Never throws. Every outcome but 'busy', 'off' and 'cooldown' is logged, so the next switch-on
  // shows in Axiom which pod healed, why, and how long after the flag read on.
  // `attempt`: 0 for a fresh ask, which must win the cooldown; n for a flip's nth retry, which
  // already holds it.
  async function heal(name: string, reason: SelfHealReason, attempt = 0): Promise<SelfHealOutcome> {
    const entry = { name: 'event-points', fn: 'selfHeal', event: name, reason, pod: deps.pod };
    // Only a flip retries: nothing else asks again for a stale map that is not empty. Each retry
    // counts, so a pod that stays busy, or a lock that stays held, cannot keep one going.
    const retryFlip = () => {
      if (reason === 'switch-on' && attempt < SWITCH_ON_RETRIES)
        deps.retryLater(() => void heal(name, reason, attempt + 1), SWITCH_ON_RETRY_MS);
    };
    let owned = false;
    try {
      if (!(await deps.isEnabled())) return 'off';
      const eventDef = await deps.loadEvent(name);
      if (!eventDef?.scoring) return 'unknown';
      if (!attempt) {
        const cooled = await deps.redis.set(selfHealCooldownKey(name, reason), reason, {
          NX: true,
          EX: SELF_HEAL_COOLDOWN_S,
        });
        if (!cooled) return 'cooldown';
      }
      // From here this pod owns the window. Another heal of this event running here (a slow settle
      // must not stack a second one) is doing this work; a flip still retries behind it.
      if (inFlight.has(name)) {
        retryFlip();
        return 'busy';
      }
      inFlight.add(name);
      owned = true;
      // Held: the hourly job (or another pod's heal) is doing this same work now. The cooldown
      // stays, so the pods do not queue up behind it.
      const lock = await deps.acquireLock(SETTLE_JOB, SETTLE_LOCK_S);
      if (!lock) {
        deps.log({ ...entry, type: 'info', outcome: 'locked', attempt });
        retryFlip();
        return 'locked';
      }
      try {
        const now = deps.now();
        const hats = (await deps.syncEventHats(now)).find((r) => r.event === name);
        const scored = { ...eventDef, scoring: eventDef.scoring };
        const settled = (await deps.getScoringPhase(eventDef, now))
          ? await deps.runReferee(scored, eventPointSeason(eventDef.startDate, now), now)
          : undefined;
        deps.log({
          ...entry,
          type: 'info',
          outcome: 'ran',
          set: hats?.set ?? 0,
          removed: hats?.removed ?? 0,
          refereeRows: settled?.rows,
          refereeChanged: settled?.changed,
        });
        return 'ran';
      } finally {
        await lock.release();
      }
    } catch (error) {
      deps.log({ ...entry, type: 'error', outcome: 'failed', message: (error as Error).message });
      return 'failed';
    } finally {
      if (owned) inFlight.delete(name);
    }
  }

  return { heal };
}

let selfHeal: ReturnType<typeof createEventPointsSelfHeal> | undefined;
function getSelfHeal() {
  selfHeal ??= createEventPointsSelfHeal({
    isEnabled: () => isEventPointsEnabled().catch(() => false),
    redis: sysRedis,
    // Unlike the route, never run unlocked: the hourly job does this work anyway.
    acquireLock: (name, lockExpiration) =>
      acquireJobLock(name, lockExpiration, sysRedis, { failOpen: false }),
    loadEvent: async (name) => (await loadEvents()).find((e) => e.name === name),
    syncEventHats,
    getScoringPhase: (event, now) => getEventScoringPhase(event, now),
    runReferee: runEventPointsReferee,
    log: (entry) => void logToAxiom(entry).catch(() => undefined),
    now: () => new Date(),
    pod: env.PODNAME,
    retryLater: (fn, ms) => void setTimeout(fn, ms).unref?.(),
  });
  return selfHeal;
}

// Detached: the caller (the engine's reload, the switch reading) never waits on a heal.
export function healEventPoints(event: string, reason: SelfHealReason) {
  void getSelfHeal().heal(event, reason);
}
