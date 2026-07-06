// Package-owned env schema for @civitai/redis. Mirrors the redis slice of the app's
// server-schema.ts so any app validates the same vars the same way on deployment.
import * as z from 'zod';

// Exported for unit tests (validates the sentinel superRefine + the HA defaults without the
// memoized loadRedisEnv singleton). Not part of the package's public API surface (index.ts).
export const redisEnvSchema = z
  .object({
    REDIS_URL: z.url(),
    REDIS_SYS_URL: z.url(),
    REDIS_TIMEOUT: z.preprocess((x) => (x ? parseInt(String(x)) : 5000), z.number().optional()),
    REDIS_CLUSTER: z.preprocess((x) => x === 'true', z.boolean().default(false)),
    // Comma-separated list of cluster node URLs for redundant discovery
    REDIS_CLUSTER_NODES: z.string().optional(),
    // Topology refresh interval in ms (default 30s)
    REDIS_CLUSTER_REFRESH_INTERVAL: z.coerce.number().default(30000),
    // sysRedis HA (Phase 1): when REDIS_SYS_SENTINELS is set the system client is built
    // via Sentinel discovery instead of the single REDIS_SYS_URL connection. Comma-separated
    // host:port list, e.g. "civitai-app-sysredis-sentinel...:26379".
    REDIS_SYS_SENTINELS: z.string().optional(),
    // Required whenever REDIS_SYS_SENTINELS is set (cluster uses "sysmaster") — see superRefine.
    REDIS_SYS_SENTINEL_NAME: z.string().optional(),
    // Only set if sentinel-auth is enabled (not initially).
    REDIS_SYS_SENTINEL_PASSWORD: z.string().optional(),
    // Socket-level inactivity guard (node-redis -> net.Socket.setTimeout). On a SILENT
    // half-open the idle timer tears the dead socket down in ~this many ms instead of
    // ~30s OS TCP keepalive (the 504-cascade structural fix). Cluster (cache) client.
    REDIS_SOCKET_TIMEOUT_MS: z.coerce.number().default(10000),
    // System client socketTimeout — default 0 (disabled): a blanket aggressive teardown
    // on the flaky single-replica sysRedis caused a reconnect storm (#2556/#2586 wedge).
    REDIS_SYS_SOCKET_TIMEOUT_MS: z.coerce.number().default(0),
    // System client reply-queue cap: with socketTimeout disabled, bounds heap growth on a
    // silent half-open by fast-failing new commands (fail-open callers catch it). 0 = off.
    REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: z.coerce.number().default(10000),
    // Keepalive PING interval. Kept comfortably below the socketTimeout — client.ts clamps
    // it to min(this, socketTimeout/2) so a healthy idle socket never spuriously fires.
    REDIS_PING_INTERVAL_MS: z.coerce.number().default(5000),
    // Cluster-only per-command wall-clock backstop BENEATH REDIS_SOCKET_TIMEOUT_MS: a ~0.5%
    // minority of cluster `_execute` promises never settle and park the SSR handler ~125s.
    // Racing against a rejecting deadline guarantees the command settles. 0 = off.
    REDIS_CLUSTER_COMMAND_TIMEOUT_MS: z.coerce.number().default(15000),
    // ── CLUSTER SELF-HEAL WATCHDOG (FIX #1/#2/#3) ──────────────────────────────────────
    // Master kill-switch. ON by default (a forced reconnect is the only thing that clears the
    // inflight-leak wedge short of a pod restart). Cluster client ONLY — the single-node
    // sysRedis client is never reconnected by this watchdog.
    REDIS_CLUSTER_SELFHEAL_ENABLED: z.preprocess(
      // default true; only the literal string 'false' disables it
      (x) => x !== 'false',
      z.boolean().default(true)
    ),
    // Inflight count strictly above which a pod is considered potentially wedged (50 matches
    // the binary-wedge observation: healthy ~0, wedged jumps past 50).
    REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD: z.coerce.number().default(50),
    // Inflight must stay ABOVE the threshold continuously for this long before a reconnect.
    REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS: z.coerce.number().default(20000),
    // Minimum time between two self-heal reconnects (at most one per cooldown).
    REDIS_CLUSTER_SELFHEAL_COOLDOWN_MS: z.coerce.number().default(60000),
    // How often the watchdog samples inflight (cheap one-gauge read).
    REDIS_CLUSTER_SELFHEAL_CHECK_INTERVAL_MS: z.coerce.number().default(1000),
    // DEADLINE-HIT / SLOW-SETTLE TRIGGER (the sawtooth-immune self-heal signal): N cluster command
    // SLOW-SETTLES within the window force a reconnect. <= 0 disables this trigger.
    REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD: z.coerce.number().default(10),
    REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS: z.coerce.number().default(20000),
    // A cluster command whose OBSERVED settle duration reaches this many ms counts as a wedge hit
    // (recordClusterCommandSettle, wired from instrumentCommands' done() — the SAME settle-time
    // observation as redis_command_duration_seconds). 2026-07-06: the trigger used to key off
    // withCommandDeadline's onTimeout (deadline REAP), which never fires when slow commands settle
    // on their own past the deadline (~29s tail), so the ring stayed empty and self-heal 0-fired.
    // Set BELOW the command deadline (15s) so an early wedge trips before the reaper and so it works
    // even if the deadline reaper is disabled. Healthy p99 ≈ 23ms, so 10s is ~400× p99 — a one-off
    // slow command is far below the N-in-window threshold. <= 0 disables slow-settle recording.
    REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: z.coerce.number().default(10000),
    // PER-POD RECONNECT JITTER (fleet-stampede brake): wait a random [0, this) before the actual
    // reconnect so a synchronized fleet event doesn't stampede the cluster. WIDENED to 3s (was 1s)
    // for the settle-time trigger: it fires on a BROADER envelope than the old reaper-only signal —
    // any cluster command completing >= REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS (10s), not just those
    // reaped at the 15s deadline. So a genuine >10s cluster event can trip ~100 pods on nearly the
    // same tick; 1s was too thin to de-correlate that many destroy()+connect()s against an already-
    // degraded cluster. 3s spreads them out while still keeping a single-pod heal well inside the
    // ~60s kubelet readiness-shed window. Env-tunable (3–5s reasonable).
    REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS: z.coerce.number().default(3000),
    // ── SYS (SENTINEL) SELF-HEAL WATCHDOG ──────────────────────────────────────────────
    // The exact mirror of the cluster self-heal, for the OTHER node-redis client — the sysRedis
    // Sentinel HA client. WHY (incident 2026-07-03): a sentinel flap orphaned in-flight commands
    // on the RedisSentinel client (inflight 7,000–253,000 per pod on ~11 pods), hung every request
    // touching sysRedis, and did NOT self-heal until the pods were manually deleted. Only the
    // SUSTAINED-INFLIGHT trigger applies here (the sys client has no per-command deadline, so
    // there's no sawtooth/deadline-hit path — inflight climbs monotonically, exactly the incident
    // signature). ON by default (a forced reconnect is the only thing that clears the wedge short
    // of a pod restart); REDIS_SYS_SELFHEAL_ENABLED=false is the single-flip revert.
    REDIS_SYS_SELFHEAL_ENABLED: z.preprocess(
      // default true; only the literal string 'false' disables it (mirrors the cluster flag)
      (x) => x !== 'false',
      z.boolean().default(true)
    ),
    // Inflight count strictly above which the sys client is considered wedged. Healthy sys inflight
    // is single-digit; the incident wedge was 7,000+ — 500 is a huge margin below any real wedge
    // yet far above any legitimate burst.
    REDIS_SYS_SELFHEAL_INFLIGHT_THRESHOLD: z.coerce.number().default(500),
    // Inflight must stay ABOVE the threshold continuously for this long before a reconnect.
    REDIS_SYS_SELFHEAL_SUSTAINED_MS: z.coerce.number().default(20000),
    // Minimum time between two sys self-heal reconnects (at most one per cooldown).
    REDIS_SYS_SELFHEAL_COOLDOWN_MS: z.coerce.number().default(60000),
    // How often the watchdog samples inflight (cheap one-counter read).
    REDIS_SYS_SELFHEAL_CHECK_INTERVAL_MS: z.coerce.number().default(1000),
    // PER-POD RECONNECT JITTER (fleet-stampede brake): wait a random [0, this) before the actual
    // sentinel reconnect so a synchronized fleet flap doesn't stampede the sentinel/master at once.
    // WIDER default than the cluster's (4s vs 1s): the sys watchdog's ONLY trigger is sustained-
    // inflight (no deadline signal), so a sysRedis MASTER that's slow-but-alive would make ~100 pods
    // all breach the same 20s window and, at 1s jitter, reconnect within a 1s spread → a thundering
    // herd on the already-degraded master/sentinel every cooldown. 4s spreads it. Env-tunable.
    REDIS_SYS_SELFHEAL_RECONNECT_JITTER_MS: z.coerce.number().default(4000),
    // ── CLUSTER ROUTING RETRY-AFTER-REDISCOVER (the topology-churn 500 wave) ────────────
    // ON by default; REDIS_CLUSTER_ROUTING_RETRY_ENABLED=false is a single-flip kill-switch
    // that restores today's exact behavior (one attempt, throw on a routing error).
    REDIS_CLUSTER_ROUTING_RETRY_ENABLED: z.preprocess(
      // default true; only the literal string 'false' disables it (mirrors the SELFHEAL flag)
      (x) => x !== 'false',
      z.boolean().default(true)
    ),
    // Max RETRIES after the initial attempt. The transient window is ~1–2 min cluster-wide but
    // any single pod's command only needs the map to settle for ITS slot — 2 retries with the
    // bounded backoff below covers the measured settle time.
    REDIS_CLUSTER_ROUTING_RETRY_MAX: z.coerce.number().default(2),
    // Backoff before the 1st / 2nd retry (ms). This IS the settle window: the rediscover between
    // attempts is a best-effort FIRE-AND-FORGET nudge (triggerTopologyRediscovery returns undefined,
    // not awaited to completion), so it's this backoff — not the rediscover call — that gives the
    // in-flight, single-flighted slot-map refresh a beat to land before the retry. 50ms then 150ms.
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MS: z.coerce.number().default(50),
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MAX_MS: z.coerce.number().default(150),
    // Used only to derive a hostname for the failover feature-flag context
    NEXTAUTH_URL: z.string().optional(),
    FLIPT_DEPLOYMENT_ID: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // node-redis's createSentinel requires the master group name; refuse to start with
    // REDIS_SYS_SENTINELS set but REDIS_SYS_SENTINEL_NAME missing. The non-sentinel path
    // (REDIS_SYS_URL only) is unaffected.
    if (env.REDIS_SYS_SENTINELS && !env.REDIS_SYS_SENTINEL_NAME) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_SYS_SENTINEL_NAME'],
        message:
          'REDIS_SYS_SENTINEL_NAME is required when REDIS_SYS_SENTINELS is set (cluster uses "sysmaster")',
      });
    }
  });

// Normalized, env-derived defaults. The factory accepts a Partial<RedisConfig> to
// override any of these per call.
function buildEnv() {
  const parsed = redisEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('[@civitai/redis] Invalid environment variables:\n' + z.prettifyError(parsed.error));
  }
  return {
    url: parsed.data.REDIS_URL,
    sysUrl: parsed.data.REDIS_SYS_URL,
    timeout: parsed.data.REDIS_TIMEOUT,
    cluster: parsed.data.REDIS_CLUSTER,
    clusterNodes: parsed.data.REDIS_CLUSTER_NODES,
    clusterRefreshInterval: parsed.data.REDIS_CLUSTER_REFRESH_INTERVAL,
    sysSentinels: parsed.data.REDIS_SYS_SENTINELS,
    sysSentinelName: parsed.data.REDIS_SYS_SENTINEL_NAME,
    sysSentinelPassword: parsed.data.REDIS_SYS_SENTINEL_PASSWORD,
    socketTimeoutMs: parsed.data.REDIS_SOCKET_TIMEOUT_MS,
    sysSocketTimeoutMs: parsed.data.REDIS_SYS_SOCKET_TIMEOUT_MS,
    sysCommandsQueueMaxLength: parsed.data.REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH,
    pingIntervalMs: parsed.data.REDIS_PING_INTERVAL_MS,
    clusterCommandTimeoutMs: parsed.data.REDIS_CLUSTER_COMMAND_TIMEOUT_MS,
    clusterSelfHealEnabled: parsed.data.REDIS_CLUSTER_SELFHEAL_ENABLED,
    clusterSelfHealInflightThreshold: parsed.data.REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD,
    clusterSelfHealSustainedMs: parsed.data.REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS,
    clusterSelfHealCooldownMs: parsed.data.REDIS_CLUSTER_SELFHEAL_COOLDOWN_MS,
    clusterSelfHealCheckIntervalMs: parsed.data.REDIS_CLUSTER_SELFHEAL_CHECK_INTERVAL_MS,
    clusterSelfHealDeadlineHitThreshold: parsed.data.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD,
    clusterSelfHealDeadlineHitWindowMs: parsed.data.REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS,
    clusterSelfHealSlowCommandMs: parsed.data.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS,
    clusterSelfHealReconnectJitterMs: parsed.data.REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS,
    sysSelfHealEnabled: parsed.data.REDIS_SYS_SELFHEAL_ENABLED,
    sysSelfHealInflightThreshold: parsed.data.REDIS_SYS_SELFHEAL_INFLIGHT_THRESHOLD,
    sysSelfHealSustainedMs: parsed.data.REDIS_SYS_SELFHEAL_SUSTAINED_MS,
    sysSelfHealCooldownMs: parsed.data.REDIS_SYS_SELFHEAL_COOLDOWN_MS,
    sysSelfHealCheckIntervalMs: parsed.data.REDIS_SYS_SELFHEAL_CHECK_INTERVAL_MS,
    sysSelfHealReconnectJitterMs: parsed.data.REDIS_SYS_SELFHEAL_RECONNECT_JITTER_MS,
    clusterRoutingRetryEnabled: parsed.data.REDIS_CLUSTER_ROUTING_RETRY_ENABLED,
    clusterRoutingRetryMax: parsed.data.REDIS_CLUSTER_ROUTING_RETRY_MAX,
    clusterRoutingRetryBackoffMs: parsed.data.REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MS,
    clusterRoutingRetryBackoffMaxMs: parsed.data.REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MAX_MS,
    nextAuthUrl: parsed.data.NEXTAUTH_URL,
    fliptDeploymentId: parsed.data.FLIPT_DEPLOYMENT_ID,
  };
}

export type RedisConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: importing this module never touches process.env. Validation runs only
// when the factory calls loadRedisEnv(), so a bare import (build, script, test) never
// throws. Parsed once, then cached.
let _env: RedisConfig | undefined;
export function loadRedisEnv(): RedisConfig {
  return (_env ??= buildEnv());
}
