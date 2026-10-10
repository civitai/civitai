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
// heal on every reload.
export const SELF_HEAL_COOLDOWN_S = 15 * 60;
export const selfHealCooldownKey = (event: string) =>
  `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:self-heal-cooldown` as const;

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
};

export function createEventPointsSelfHeal(deps: SelfHealDeps) {
  // A heal already running on this pod: a slow settle must not stack a second one behind it.
  const inFlight = new Set<string>();

  // Never throws. Every outcome but 'busy' and 'off' is logged, so the next switch-on shows in
  // Axiom which pod healed, why, and how long after the flag read on.
  async function heal(name: string, reason: SelfHealReason): Promise<SelfHealOutcome> {
    if (inFlight.has(name)) return 'busy';
    inFlight.add(name);
    const entry = { name: 'event-points', fn: 'selfHeal', event: name, reason, pod: deps.pod };
    try {
      if (!(await deps.isEnabled())) return 'off';
      const eventDef = await deps.loadEvent(name);
      if (!eventDef?.scoring) return 'unknown';
      const cooled = await deps.redis.set(selfHealCooldownKey(name), reason, {
        NX: true,
        EX: SELF_HEAL_COOLDOWN_S,
      });
      if (!cooled) return 'cooldown';
      // Held: the hourly job (or another pod's heal) is doing this same work now. The cooldown
      // stays, so the pods do not queue up behind it.
      const lock = await deps.acquireLock(SETTLE_JOB, SETTLE_LOCK_S);
      if (!lock) {
        deps.log({ ...entry, type: 'info', outcome: 'locked' });
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
      inFlight.delete(name);
    }
  }

  return { heal };
}

let selfHeal: ReturnType<typeof createEventPointsSelfHeal> | undefined;
function getSelfHeal() {
  selfHeal ??= createEventPointsSelfHeal({
    isEnabled: () => isEventPointsEnabled().catch(() => false),
    redis: sysRedis,
    acquireLock: (name, lockExpiration) => acquireJobLock(name, lockExpiration),
    loadEvent: async (name) => (await loadEvents()).find((e) => e.name === name),
    syncEventHats,
    getScoringPhase: (event, now) => getEventScoringPhase(event, now),
    runReferee: runEventPointsReferee,
    log: (entry) => void logToAxiom(entry).catch(() => undefined),
    now: () => new Date(),
    pod: env.PODNAME,
  });
  return selfHeal;
}

// Detached: the caller (the engine's reload, the switch reading) never waits on a heal.
export function healEventPoints(event: string, reason: SelfHealReason) {
  void getSelfHeal().heal(event, reason);
}
