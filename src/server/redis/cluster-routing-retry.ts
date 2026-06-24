import { env } from '~/env/server';

/**
 * Retry-after-rediscover guard for TRANSIENT cluster ROUTING failures (the topology-churn
 * 500 wave that #2665 does NOT cover).
 *
 * WHY: civitai-dp-prod talks to a sharded `next-redis-cluster` via the node-redis cluster
 * client (@redis/client@5.8.3). During ANY cluster topology change — a rolling update, a node
 * failover, or a scale event — the cluster slot map is transiently inconsistent. In that
 * window the client throws FLEET-WIDE, BEFORE the command is dispatched to any node:
 *
 *   TypeError: Cannot read properties of undefined (reading 'replicas')
 *     at RedisClusterSlots.getSlotRandomNode (cluster-slots.js:342:19)
 *
 * Measured during a LIVE rolling update: 1,696 of these throws in 15 minutes across ~90 pods
 * (SSR -primary, api-primary, api-heavy), surfacing as user-facing HTTP 500s on GENERAL cache
 * READ paths (tag.getAll, image.getGenerationData, hiddenPreferences.getHidden,
 * nowPayments.getSupportedCurrencies, reaction.toggle, user.checkNotifications, …). The cluster
 * itself stays healthy (`cluster_state=ok`); it is purely the CLIENT mishandling topology churn.
 * The waves self-clear in ~1–2 min as topology settles.
 *
 * Why #2665 does NOT cover this (verified, not duplicated):
 *  - FIX #1 ClusterSelfHealWatchdog forces a reconnect only when the inflight counter stays
 *    >50 for a sustained 20s window (the HANG-wedge signature). The getSlotRandomNode throw is
 *    IMMEDIATE (fails fast, never pins inflight) → the watchdog never sees it; and when it does
 *    fire, its destroy()→flushAll() rejects in-flight commands = its own 500 burst.
 *  - FIX #3 withMetricWriteFailSoft fail-softs ONLY the metrics:lock/hIncrBy WRITE path; the
 *    wave's 500s are general READS (confirmed metric-write-failsoft_total=0 during the wave).
 *
 * THE SAFETY ARGUMENT (the key insight that makes this safe for ALL commands, reads AND
 * writes/mutations): getSlotRandomNode throws during NODE SELECTION — BEFORE the command is
 * dispatched to any node. The command NEVER EXECUTED. Therefore a bounded retry-after-rediscover
 * carries ZERO double-execution risk for writes/mutations: there is nothing to re-do, only a
 * fresh node-selection attempt against the (now hopefully settled) slot map. That is cleaner and
 * broader than a read-path-only fail-open, which would still 500 every write during the wave.
 *
 * BEHAVIOR PRESERVED: after exhausting the bounded retries the ORIGINAL error is RE-THROWN — no
 * silent swallow, today's failure mode is unchanged for a genuinely persistent break. The guard
 * is default-ON but fully kill-switchable via REDIS_CLUSTER_ROUTING_RETRY_ENABLED=false (restores
 * the current behavior: one attempt, throw on a routing error).
 *
 * SCOPE: cluster client ONLY (wired at the cluster `_execute` chokepoint in client.ts). The
 * single-node sysRedis client is NEVER wrapped — a blanket sys-client change caused the
 * #2556/#2586 wedge. NO money/entitlement blast radius: this is cache/routing only; money and
 * entitlement live in Postgres + the single-node sysRedis client this never touches.
 *
 * Pure (no static prom import — the counter increment is injected via onResult exactly like the
 * existing redis metrics, read off globalThis in client.ts) so it is unit-testable in isolation.
 */

/** Tiny error-shape probe that tolerates non-Error throws (string, plain object) without
 *  assuming `.message`/`.name`/`.constructor` exist. */
function errText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    // Include name + message + the top of the stack (the getSlotRandomNode frame lives there).
    return `${err.name}: ${err.message}\n${err.stack ?? ''}`;
  }
  // Plain object / unknown — best-effort stringify of message-like fields.
  const anyErr = err as { name?: unknown; message?: unknown; code?: unknown };
  return [anyErr.name, anyErr.code, anyErr.message]
    .filter((x) => typeof x === 'string')
    .join(': ');
}

/**
 * TRUE iff `err` is a TRANSIENT pre-dispatch cluster-routing failure — i.e. "there is no node
 * for this slot RIGHT NOW because the slot map is mid-rediscovery". Matched conservatively so a
 * real WRONGTYPE, an auth failure, or an app bug still throws:
 *
 *  - the getSlotRandomNode `Cannot read properties of undefined (reading 'replicas')` TypeError
 *    (the exact fleet-wide throw measured during the rolling update);
 *  - sibling node-selection failures: a message/name mentioning `getSlotRandomNode`, a
 *    `getSlotMaster`/`getSlotRandomNode`-style "undefined reading 'replicas'/'master'/'client'"
 *    on an empty slot, an explicit `NoSlot`/"no slot"/"slot not served" error;
 *  - the `ClientClosedError` / `DisconnectsClientError` a CONCURRENT self-heal reconnect (FIX #1
 *    destroy()→flushAll) produces — also pre/at-dispatch and safe to re-route after rediscover.
 *
 * Deliberately does NOT match: WRONGTYPE, NOAUTH/auth, CROSSSLOT (a real key-distribution bug,
 * not a transient), MOVED/ASK (node-redis handles those internally), generic ReplyError, or any
 * arbitrary TypeError whose text doesn't mention the routing-specific tokens above.
 */
export function isTransientClusterRoutingError(err: unknown): boolean {
  if (err == null) return false;

  const name = err instanceof Error ? err.name : '';
  const text = errText(err);
  if (!text) return false;

  // The concurrent-reconnect errors node-redis raises when destroy()/flushAll rejected the
  // queue (FIX #1 self-heal) or the socket closed mid-route. Pre/at-dispatch → safe to retry.
  if (
    name === 'ClientClosedError' ||
    name === 'DisconnectsClientError' ||
    /\bClientClosedError\b/.test(text) ||
    /\bDisconnectsClientError\b/.test(text)
  ) {
    return true;
  }

  // The exact getSlotRandomNode throw + its sibling empty-slot node-selection failures. The
  // canonical signature is a TypeError "Cannot read properties of undefined (reading 'replicas')"
  // raised from getSlotRandomNode; we match either the frame name OR the undefined-read on a
  // routing field, so a future node-redis patch that renames the frame still matches by shape.
  if (/getSlotRandomNode|getSlotMaster|getRandomNode/.test(text)) return true;
  if (
    /reading '(replicas|master|client|nodes)'/.test(text) &&
    /undefined|null/.test(text)
  ) {
    return true;
  }

  // Explicit "no node for this slot" style errors.
  if (/\bNoSlot\b/i.test(text) || /no slot|slot not served|slot is not served/i.test(text)) {
    return true;
  }

  return false;
}

export type ClusterRoutingRetryResult = 'recovered' | 'exhausted';

export interface ClusterRoutingRetryOptions {
  /**
   * Trigger a topology rediscovery between attempts. Awaited (errors swallowed by the caller's
   * wiring — a failed rediscover just means the retry runs against the same slot map and likely
   * re-throws, which is still no worse than today). Injected so the pure module needs no redis
   * import. If omitted, retries still occur (a fast in-flight rediscover from another path may
   * have settled the map) but without an explicit nudge.
   */
  rediscover?: () => void | Promise<unknown>;
  /** Master kill-switch. Defaults to REDIS_CLUSTER_ROUTING_RETRY_ENABLED. When false: pass-through
   *  (run exec() once, no retry, no rediscover — restores current behavior). */
  enabled?: boolean;
  /** Max RETRIES after the initial attempt. Defaults to REDIS_CLUSTER_ROUTING_RETRY_MAX (2).
   *  0 = no retry (still a pass-through for the initial attempt). */
  maxRetries?: number;
  /** Backoff before retry #1 / #2 (ms). Defaults to the two env knobs (50ms, 150ms). For retries
   *  beyond the array length the LAST value is reused. */
  backoffMs?: number[];
  /**
   * Fire-and-forget hook on settle: ('recovered' once a retry SUCCEEDS, 'exhausted' once retries
   * are exhausted and the original error is about to re-throw). Wired in client.ts to the
   * civitai_app_redis_routing_retry_total{result=…} prom counter via the globalThis bridge.
   * Never throws into the hot path (isolated in a try/catch here).
   */
  onResult?: (result: ClusterRoutingRetryResult) => void;
  /** Injectable sleep (tests pass a no-op / fake-timer-friendly impl). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Run `exec()`. On a TRANSIENT cluster-routing error (isTransientClusterRoutingError), trigger
 * ONE rediscover() and retry with a small bounded backoff, up to `maxRetries` times. On success
 * after a retry → fire onResult('recovered'). After exhausting the retries → fire
 * onResult('exhausted') and RE-THROW THE ORIGINAL error (no silent swallow). A NON-transient
 * error (WRONGTYPE, auth, app bug) → re-thrown IMMEDIATELY, no rediscover, no retry.
 *
 * Single-flight/idempotent-safe by construction: a transient routing error means the command
 * NEVER reached a node, so re-running exec() cannot double-execute a write/mutation.
 *
 * Disabled (enabled=false) → pure pass-through: exec() runs exactly once and any error propagates
 * unchanged (today's behavior). On the happy path exec() is called EXACTLY ONCE.
 */
export async function withClusterRoutingRetry<T>(
  exec: () => Promise<T>,
  options: ClusterRoutingRetryOptions = {}
): Promise<T> {
  const enabled = options.enabled ?? env.REDIS_CLUSTER_ROUTING_RETRY_ENABLED;
  if (!enabled) return exec();

  const maxRetries = Math.max(
    0,
    options.maxRetries ?? env.REDIS_CLUSTER_ROUTING_RETRY_MAX
  );
  const backoff =
    options.backoffMs ?? [
      env.REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MS,
      env.REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MAX_MS,
    ];
  const sleep = options.sleep ?? defaultSleep;

  const fire = (result: ClusterRoutingRetryResult) => {
    try {
      options.onResult?.(result);
    } catch {
      // A broken counter hook must never break the guard.
    }
  };

  let attempt = 0;
  // Total attempts = 1 initial + maxRetries.
  for (;;) {
    try {
      const value = await exec();
      // recovered === we succeeded on a RETRY (attempt > 0). The initial-attempt happy path is
      // unchanged and uncounted.
      if (attempt > 0) fire('recovered');
      return value;
    } catch (err) {
      // Non-transient OR retries exhausted → preserve today's behavior: re-throw the ORIGINAL.
      if (!isTransientClusterRoutingError(err)) throw err;
      if (attempt >= maxRetries) {
        fire('exhausted');
        throw err;
      }

      // Bounded backoff, then nudge a rediscover and retry. The command never reached a node, so
      // this is safe for reads AND writes.
      const waitMs = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
      if (waitMs > 0) await sleep(waitMs);
      if (options.rediscover) {
        try {
          await options.rediscover();
        } catch {
          // A failed rediscover just means the retry runs against the same map → likely re-throws,
          // no worse than today. Never let it mask the original routing error.
        }
      }
      attempt += 1;
    }
  }
}
