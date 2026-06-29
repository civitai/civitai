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
 * writes/mutations): the retried error shapes throw during NODE SELECTION / SLOT ROUTING — BEFORE
 * the command is dispatched to any node. The command NEVER EXECUTED. Therefore a bounded
 * retry-after-rediscover carries ZERO double-execution risk for writes/mutations: there is nothing
 * to re-do, only a fresh node-selection attempt against the (now hopefully settled) slot map. That
 * is cleaner and broader than a read-path-only fail-open, which would still 500 every write during
 * the wave.
 *
 * SCOPE OF THE RETRY — PRE-DISPATCH ONLY (audit-narrowed): the guard retries ONLY provably
 * pre-dispatch routing throws — the getSlotRandomNode `reading 'replicas'/'master'` TypeError and
 * `NoSlot`/"no slot"-style cluster routing errors. It DELIBERATELY does NOT retry the reconnect
 * rejections `ClientClosedError` / `DisconnectsClientError`. Per #2665 (cluster-selfheal.ts:113),
 * a self-heal reconnect's `destroy()` → `queue.flushAll(new DisconnectsClientError())` rejects
 * BOTH the not-yet-written queue AND the `#waitingForReply` queue — i.e. commands ALREADY WRITTEN
 * to the socket and awaiting a reply. node-redis (@redis/client 5.8.x) gives the caller NO signal
 * to tell "never sent" from "sent, server may have applied it, socket torn down before the reply".
 * Retrying a `DisconnectsClientError` could therefore DOUBLE-EXECUTE a non-idempotent cluster
 * write (hIncrBy/incrBy/lPush/rPush/sAdd/zAdd). So those errors fail the caller exactly as they do
 * today (#2665's invariant: a self-heal reconnect reject fails the caller — it is NOT retried).
 * MULTI/pipeline (`#queue.addCommand`) is out of scope by design — this guard wraps the single
 * cluster `_execute` chokepoint, not transactions.
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
 * TRUE iff `err` is a TRANSIENT *PRE-DISPATCH* cluster-routing failure — i.e. "there is no node
 * for this slot RIGHT NOW because the slot map is mid-rediscovery", thrown during node selection
 * BEFORE the command reaches any node. Matched conservatively so a real WRONGTYPE, an auth failure,
 * or an app bug still throws:
 *
 *  - the getSlotRandomNode `Cannot read properties of undefined (reading 'replicas')` TypeError
 *    (the exact fleet-wide throw measured during the rolling update);
 *  - sibling node-selection failures: a message/name mentioning `getSlotRandomNode`, a
 *    `getSlotMaster`/`getSlotRandomNode`-style "undefined reading 'replicas'/'master'" on an empty
 *    slot, an explicit `NoSlot`/"no slot"/"slot not served" error;
 *  - the `nodeClient(undefined)` "undefined (reading 'connectPromise')" TypeError (a THIRD
 *    pre-dispatch shape): during topology churn `nodeClient(node)` (cluster-slots.js:213) is called
 *    with `node === undefined` (empty-topology / keyless-command edge, or a slot whose `master` is
 *    undefined) and reads `.connectPromise` off it, with a `getClient`/`nodeClient` stack frame
 *    (NOT getSlotRandomNode, NOT replicas|master). The node is selected at cluster/index.js:177
 *    BEFORE the dispatch try/catch — provably pre-dispatch, so retrying is write-safe exactly like
 *    the getSlotRandomNode shape; without this the wave's keyless-command/empty-topology 500s slip
 *    through.
 *
 * Deliberately does NOT match (any of these re-throws so the caller sees today's behavior):
 *  - WRONGTYPE, NOAUTH/auth, CROSSSLOT (a real key-distribution bug, not a transient), MOVED/ASK
 *    (node-redis handles those internally), generic ReplyError, or any arbitrary TypeError whose
 *    text doesn't mention the routing-specific tokens above;
 *  - the reconnect rejections `ClientClosedError` / `DisconnectsClientError` (AUDIT-NARROWED, was
 *    previously matched). A #2665 self-heal reconnect's `destroy()` → `queue.flushAll(new
 *    DisconnectsClientError())` rejects the `#waitingForReply` queue too — i.e. commands ALREADY
 *    WRITTEN to the socket and awaiting a reply, which the server may have ALREADY APPLIED before
 *    the socket teardown. The client gives no signal to distinguish "never sent" from "sent and
 *    applied", so retrying these could DOUBLE-EXECUTE a non-idempotent write (hIncrBy/incrBy/
 *    lPush/rPush/sAdd/zAdd). They are therefore NOT transient for this guard's purposes — they
 *    fail the caller exactly as before (preserving #2665's "a reconnect reject fails the caller"
 *    invariant). Verified against @redis/client 5.8.x: `flushAll` (commands-queue.js) rejects both
 *    `#toWrite` (pre-dispatch, safe) and `#waitingForReply` (post-dispatch, unsafe) with the SAME
 *    error — so error name alone cannot prove the command never ran.
 */
export function isTransientClusterRoutingError(err: unknown): boolean {
  if (err == null) return false;

  const text = errText(err);
  if (!text) return false;

  // The exact getSlotRandomNode throw + its sibling empty-slot node-selection failures. The
  // canonical signature is a TypeError "Cannot read properties of undefined (reading 'replicas')"
  // raised from getSlotRandomNode; we match either the frame name OR the undefined-read on a
  // routing field, so a future node-redis patch that renames the frame still matches by shape.
  // The documented pre-dispatch routing fields are `replicas`/`master` (getSlotRandomNode /
  // getSlotMaster) AND `connectPromise` — the latter is `nodeClient(node)` (cluster-slots.js:213)
  // called with `node === undefined` (empty-topology / keyless-command edge, or a slot whose
  // `master` is undefined), throwing "Cannot read properties of undefined (reading 'connectPromise')"
  // with a `getClient`/`nodeClient` stack frame. That path is selected at cluster/index.js:177
  // BEFORE the dispatch try/catch (same pre-dispatch guarantee as getSlotRandomNode → safe to
  // retry for writes too). `client` and `nodes` were dropped as speculative breadth (audit 🟡)
  // since they're not the measured shapes.
  if (/getSlotRandomNode|getSlotMaster|getRandomNode/.test(text)) return true;
  if (/reading '(replicas|master|connectPromise)'/.test(text) && /undefined|null/.test(text)) {
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
   * Best-effort FIRE-AND-FORGET nudge to kick off a topology rediscovery between attempts. This is
   * NOT awaited to completion: the wired-in `triggerTopologyRediscovery` (client.ts) starts
   * `_slots.rediscover(...).catch(...)` but returns `undefined`, so awaiting this resolves
   * immediately. It is the BACKOFF (below) — not this call — that gives the in-flight slot-map
   * refresh time to settle before the retry runs (node-redis single-flights rediscover, so the
   * nudge just ensures one is in progress). Injected so the pure module needs no redis import. If
   * omitted, retries still occur (a fast in-flight rediscover from another path may have settled the
   * map) but without an explicit nudge. Any error is swallowed by the wrapper — a failed nudge just
   * means the retry runs against the same slot map and likely re-throws, no worse than today.
   */
  rediscover?: () => void | Promise<unknown>;
  /** Master kill-switch. Defaults to DEFAULT_ENABLED (true); client.ts injects
   *  config.clusterRoutingRetryEnabled (REDIS_CLUSTER_ROUTING_RETRY_ENABLED). When false:
   *  pass-through (run exec() once, no retry, no rediscover — restores current behavior). */
  enabled?: boolean;
  /** Max RETRIES after the initial attempt. Defaults to DEFAULT_MAX_RETRIES (2); client.ts injects
   *  config.clusterRoutingRetryMax (REDIS_CLUSTER_ROUTING_RETRY_MAX). 0 = no retry (still a
   *  pass-through for the initial attempt). */
  maxRetries?: number;
  /** Backoff before retry #1 / #2 (ms). Defaults to DEFAULT_BACKOFF_MS ([50, 150]); client.ts
   *  injects [config.clusterRoutingRetryBackoffMs, config.clusterRoutingRetryBackoffMaxMs]. For
   *  retries beyond the array length the LAST value is reused. */
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
 * Built-in defaults when an option override is absent. The package config (env.ts) parses the
 * SAME defaults from REDIS_CLUSTER_ROUTING_RETRY_{ENABLED,MAX,BACKOFF_MS,BACKOFF_MAX_MS} and
 * client.ts passes its `config.clusterRoutingRetry*` values in via the options below, so the
 * deployed behavior is env-driven. These literals keep the module PURE and unit-testable in
 * isolation (no env import) — mirroring cluster-selfheal.ts, which likewise takes its config from
 * the caller rather than reading env itself. KEEP IN SYNC with env.ts's defaults.
 */
const DEFAULT_ENABLED = true;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [50, 150];

/**
 * Run `exec()`. On a TRANSIENT cluster-routing error (isTransientClusterRoutingError), wait a small
 * bounded backoff, fire a best-effort rediscover() NUDGE (fire-and-forget — see below), then retry,
 * up to `maxRetries` times. NOTE: the backoff is the real settle window — the rediscover() nudge is
 * not awaited to completion (the wired `triggerTopologyRediscovery` returns undefined, so awaiting
 * it resolves immediately), it only ensures a single-flighted slot-map refresh is in progress while
 * the backoff gives it a beat to land. On success after a retry → fire onResult('recovered'). After
 * exhausting the retries → fire onResult('exhausted') and RE-THROW THE ORIGINAL error (no silent
 * swallow). A NON-transient error (WRONGTYPE, auth, app bug) → re-thrown IMMEDIATELY, no rediscover,
 * no retry.
 *
 * Single-flight/idempotent-safe by construction: the retried error shapes are all PRE-DISPATCH
 * (node-selection / NoSlot), meaning the command NEVER reached a node, so re-running exec() cannot
 * double-execute a write/mutation. The reconnect rejections (ClientClosedError /
 * DisconnectsClientError) are intentionally NOT retried — they can fire on already-dispatched,
 * possibly-already-applied commands (see isTransientClusterRoutingError) and so re-throw as before.
 *
 * Disabled (enabled=false) → pure pass-through: exec() runs exactly once and any error propagates
 * unchanged (today's behavior). On the happy path exec() is called EXACTLY ONCE.
 */
export async function withClusterRoutingRetry<T>(
  exec: () => Promise<T>,
  options: ClusterRoutingRetryOptions = {}
): Promise<T> {
  // Fallbacks are the package's built-in defaults (DEFAULT_*). The app's env-driven values are
  // injected by client.ts via these options (config.clusterRoutingRetry*), so this stays a PURE
  // module — no `~/env/server` and no loadRedisEnv() import — exactly like cluster-selfheal.ts,
  // which also takes its config from the caller.
  const enabled = options.enabled ?? DEFAULT_ENABLED;
  if (!enabled) return exec();

  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
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

      // Bounded backoff (the real settle window), then fire a best-effort rediscover NUDGE
      // (fire-and-forget — not awaited to completion; it just ensures an in-flight slot-map refresh
      // is running while the backoff gives it time to land) and retry. Only pre-dispatch routing
      // shapes reach here (the predicate excludes the reconnect rejections), so the command never
      // reached a node — safe to retry for reads AND writes (no double-execution).
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
