// @ts-check
import * as z from 'zod';
import { zc } from '~/utils/schema-helpers';
import {
  commaDelimitedStringArray,
  commaDelimitedStringObject,
  stringToArray,
} from '~/utils/zod-helpers';
import { isProd } from './other';

/**
 * Specify your server-side environment variables schema here.
 * This way you can ensure the app isn't built with invalid env vars.
 */
export const serverSchema = z
  .object({
    DATABASE_IS_PROD: zc.booleanString.default(isProd),
    DATABASE_URL: z.url(),
    DATABASE_REPLICA_URL: z.url(),
    DATABASE_REPLICA_LONG_URL: z.url().optional(),
    DATABASE_SSL: zc.booleanString.default(true),
    // The monolith no longer connects to the notification DB — that moved to apps/notifications, which
    // the monolith reaches via @civitai/notifications (NOTIFICATIONS_ENDPOINT). Optional now: nothing in
    // src/ reads these; kept so existing envs that still set them don't error.
    NOTIFICATION_DB_URL: z.url().optional(),
    NOTIFICATION_DB_REPLICA_URL: z.url().optional(),
    DATAPACKET_DATABASE_RO_URL: z.url().optional(),
    // App Blocks W4-KV-v0 — connection to cnpg-cluster-apps (`apps` DB) where
    // each approved app block gets an isolated schema. civitai-web is the only
    // service with these creds; apps never see DB credentials directly. Optional
    // so PR previews + dev environments that haven't provisioned the apps DB
    // yet keep starting (the storage tRPC procedures throw cleanly when unset).
    APPS_DATABASE_URL: z.url().optional(),
    DATABASE_CONNECTION_TIMEOUT: z.coerce.number().default(0),
    DATABASE_POOL_MAX: z.coerce.number().default(20),
    NOTIFICATION_POOL_MAX: z.coerce.number().optional(),
    DATABASE_POOL_IDLE_TIMEOUT: z.coerce.number().default(30000),
    DATABASE_READ_TIMEOUT: z.coerce.number().optional(),
    DATABASE_WRITE_TIMEOUT: z.coerce.number().optional(),
    REDIS_URL: z.url(),
    REDIS_CLUSTER: z.preprocess((x) => x === 'true', z.boolean().default(false)),
    REDIS_CLUSTER_NODES: z.string().optional(), // Comma-separated list of cluster node URLs for redundant discovery
    REDIS_CLUSTER_REFRESH_INTERVAL: z.coerce.number().default(30000), // Topology refresh interval in ms (default 30s)
    REDIS_SYS_URL: z.url(),
    // Optional Sentinel-mode env vars for the `system` Redis client. When
    // REDIS_SYS_SENTINELS is unset (default), the existing REDIS_SYS_URL path is
    // used and behavior is unchanged. When set, src/server/redis/client.ts
    // switches the system client to `createSentinel(...)` against this Sentinel
    // pool. See claudedocs/sysredis-ha-migration-runbook.md (datapacket-talos)
    // for the rollout sequence.
    REDIS_SYS_SENTINELS: z.string().optional(), // comma-separated host:port list, e.g. "civitai-app-sysredis-sentinel.civitai-app-sysredis.svc.cluster.local:26379"
    // Master group name. No default — the cluster uses "sysmaster", and the
    // historical Sentinel default ("mymaster") would silently fail every lookup.
    // The superRefine below makes this required whenever REDIS_SYS_SENTINELS is set.
    REDIS_SYS_SENTINEL_NAME: z.string().optional(),
    REDIS_SYS_SENTINEL_PASSWORD: z.string().optional(), // only set if sentinel-auth is enabled (not initially)
    REDIS_TIMEOUT: z.preprocess((x) => (x ? parseInt(String(x)) : 5000), z.number().optional()),
    // Socket-level inactivity timeout (ms). Passed to node-redis `socket.socketTimeout`,
    // which maps to net.Socket.setTimeout — an IDLE timer that fires when NO read OR
    // write activity happens on the live socket for this long (any command write or
    // received reply resets it; verified empirically against @redis/client@5.8.3 +
    // a real redis-server). Its job is to kill a SILENT half-open connection (pod
    // reschedule/failover with no RST/FIN): during a real stall the in-flight command
    // is PARKED in the node-redis queue and blocks every subsequent write (including
    // the keepalive PING), so the idle timer runs to completion and tears the dead
    // socket down in ~REDIS_SOCKET_TIMEOUT_MS instead of waiting ~30s for OS TCP
    // keepalive — the root cause of the api-primary 504 cascades. 10s is comfortably
    // above normal round-trip latency (<5ms). Tunable so it can be widened/disabled in
    // prod without a redeploy.
    //
    // ⚠️ INVARIANT: REDIS_PING_INTERVAL_MS MUST stay well below this value, otherwise a
    // HEALTHY but idle socket (off-peak, a cold slot range, a quiet pod) goes idle for
    // > socketTimeout with no traffic and the idle timer fires on a perfectly good node
    // → spurious reconnect churn. The keepalive PING is what keeps an idle-but-healthy
    // socket under the timeout. client.ts derives + clamps the ping interval to enforce
    // this even if the two envs are mis-set; see getBaseClient().
    REDIS_SOCKET_TIMEOUT_MS: z.coerce.number().default(10000),
    // socketTimeout for the SYSTEM (sysRedis) client specifically. The structural
    // 504-cascade fix above is needed on the CLUSTER (cache) client, where a silent
    // half-open parks ALL request handlers. The system client is single-node and mostly
    // idle, and the flaky single-replica sysRedis backend does not cleanly complete the
    // TCP close on teardown — so the aggressive 10s socketTimeout there does NOT heal a
    // blip, it ACCUMULATES half-closed sockets ([RxClosing TxClosing]) into a reconnect
    // storm that wedges /api/health (the readiness probe) for hours. Default 0 = disabled
    // → the sys client reverts to its pre-#2556 self-healing behavior (a sys half-open
    // just blips the 5s health-check deadline and clears, no teardown storm). Tunable up
    // if a real sys half-open guard is ever wanted, but it must be paired with a backend
    // that closes cleanly. See getBaseClient().
    REDIS_SYS_SOCKET_TIMEOUT_MS: z.coerce.number().default(0),
    // Wall-clock deadline (ms) for EVERY per-request sysRedis read (the refreshToken
    // MULTI and the single-command config/session reads). The sys client has no
    // socketTimeout (above), and node-redis's per-command timeout can't bound a command
    // once written nor any MULTI sub-command — so on a silent half-open a sys read parks
    // (~OS-keepalive minutes) per request without this. Bounds the request handler and
    // fails open. 0 disables it. See redis/sys-read-deadline.ts withSysReadDeadline().
    REDIS_SYS_READ_TIMEOUT_MS: z.coerce.number().default(2000),
    // Bound on the sys client's node-redis command queue. The sys client has no
    // socketTimeout, so on a SILENT half-open it is only cleared by OS TCP keepalive
    // (minutes), during which every authenticated request enqueues a MULTI that never
    // drains → an UNBOUNDED queue → heap growth / OOM. Capping the queue makes new
    // commands fast-fail (`The queue is full`) once wedged, which the fail-open callers
    // catch — bounding the heap instead of OOMing the pod. 0 = unbounded (node-redis
    // default). Only applied to the system client; the cache client self-bounds via its
    // socketTimeout. See getBaseClient().
    REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: z.coerce.number().default(10000),
    // Keepalive PING interval (ms). node-redis issues a `PING` every interval ONLY when
    // the socket is otherwise idle (a parked/in-flight command blocks it from being
    // written). Each PING is a write+reply round-trip that resets the socketTimeout idle
    // timer, so it keeps a HEALTHY idle socket alive while a genuinely half-open one
    // (where the parked command blocks the PING) still trips socketTimeout. MUST be
    // comfortably below REDIS_SOCKET_TIMEOUT_MS — client.ts additionally clamps it to
    // min(this, socketTimeout/2) so the invariant holds even on a misconfig. Default 5s
    // (≈ half the 10s default socketTimeout). PING load is trivial: one tiny command per
    // idle node per interval (cluster: per node; a few nodes × pods × 0.2/s).
    REDIS_PING_INTERVAL_MS: z.coerce.number().default(5000),
    // Bounded per-command wall-clock timeout (ms) for the CLUSTER (cache) client ONLY —
    // a defensive backstop BENEATH REDIS_SOCKET_TIMEOUT_MS that guarantees no cluster
    // command can hang forever.
    //
    // Observed on civitai-dp-prod SSR pool: a small (~0.5%) minority of cluster commands
    // NEVER settle (the `_execute` promise neither resolves nor rejects), even though the
    // socketTimeout above should reject a stuck command in ~10s. Inferred cause (not proven
    // from node-redis source): node-redis CLUSTER retry / topology-rediscovery re-routes a
    // command across reconnects, so the outer `_execute` promise the instrumentation wraps
    // is orphaned. Each such command (1) leaks the redis_commands_inflight gauge (inc'd in
    // instrumentCommands, the matching dec only fires when `_execute` settles) and (2) PARKS
    // the request handler up to ~125s until the client/CF disconnects → flat-125s 499s on
    // normal SSR routes. (SSR inflight climbed 104→32,331 over ~14h; ~2,828 flat-125s 499s
    // at peak; healthy pods show 0.)
    //
    // This races `_execute` against a rejecting timer so a command that doesn't settle in
    // time REJECTS — which makes the wrapped promise settle → `.finally(done)` fires → the
    // inflight gauge dec's AND the handler unparks with an error instead of a 125s hang.
    // The reject flows the SAME way an existing cluster read error already does (socketTimeout
    // has rejected stuck commands down these paths since #2556): BOTH fetchThroughCache AND
    // createCachedObject/Array.fetch now catch it and fail-open (degraded origin fetch → slow
    // 200, bounded against a DB stampede by per-id single-flight — see cache-helpers.ts
    // degradedIdInFlight). createCachedArray.fetch was made fail-open so this reject degrades
    // rather than 500ing: before it, a deadline-reject down a cachedObject read propagated as a
    // 500 (a 68-min two-pod 500 spike on 2026-06-17). Correct regardless of the exact node-redis
    // internal cause.
    //
    // Default 15000 (15s): ~650× over the ~23ms healthy-completion p99 (zero risk of clipping a
    // legitimate slow command) and well below the ~125s client ceiling. Sits ABOVE
    // REDIS_SOCKET_TIMEOUT_MS (10s) so it is a true BACKSTOP — socketTimeout still does the
    // primary teardown when it works; this only catches the commands it doesn't. NOTE: this is a
    // GLOBAL cap on EVERY cluster command, but only the cache-read paths (fetchThroughCache +
    // createCachedArray) fail open — a non-fail-open command that rejects on the deadline still
    // surfaces as an error. Lowering this (toward ~3s, which is safe for the now-fail-open cache
    // reads) is DEFERRED to a separate change so the createCachedArray fail-open above can be
    // soaked + attributed first without bundling a global timeout change. 0 disables it.
    // Cluster-scoped: the SYSTEM client is untouched (it uses REDIS_SYS_READ_TIMEOUT_MS — see the
    // #2556/#2586 sys-client regression). See redis/command-deadline.ts withCommandDeadline() +
    // instrumentCommands() and utils/cache-helpers.ts (fetchThroughCache + createCachedArray
    // fail-open).
    REDIS_CLUSTER_COMMAND_TIMEOUT_MS: z.coerce.number().default(15000),

    // ── CLUSTER CLIENT SELF-HEAL WATCHDOG (FIX #1, the inflight-leak wedge) ──────────
    //
    // The per-command deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS) reaps each individual
    // orphaned `_execute` promise (turns a 125s hang into an error so the gauge dec's and
    // the handler unparks), but it NEVER resets the wedged client/socket: once a pod's
    // cluster client starts orphaning commands across a retry / `_slots.rediscover()`
    // topology refresh, the NEXT command orphans identically → the pod produces 500s/slow-
    // degrades indefinitely. Only a full client reconnect (or a process restart) rebuilds
    // the connections/`_slots` and clears the orphaned promises.
    //
    // Signature of a wedged pod: `redis_commands_inflight{client="cluster"}` jumps PAST the
    // threshold and stays PINNED (hundreds–thousands of leaked inflight) — a healthy pod
    // sits near 0 and a busy pod only spikes transiently. The watchdog samples the same
    // in-process inflight counter that feeds the gauge; when it stays ABOVE the threshold
    // CONTINUOUSLY for the sustained window it forces ONE reconnect, then waits out a
    // cooldown before it can fire again (so it can never become a reconnect storm).
    //
    // ON by default (this is the only thing that clears the wedge short of a pod restart),
    // but fully kill-switchable via REDIS_CLUSTER_SELFHEAL_ENABLED=false. Cluster client
    // ONLY — the single-node sysRedis client is never reconnected by this watchdog.
    REDIS_CLUSTER_SELFHEAL_ENABLED: z.preprocess(
      // default true; only the literal string 'false' disables it
      (x) => x !== 'false',
      z.boolean().default(true)
    ),
    // Inflight count above which a pod is considered POTENTIALLY wedged. Must be > the
    // command-deadline guard's effective concurrency floor so a merely-busy pod doesn't
    // trip it. 50 matches the binary-wedge observation (healthy ~0, wedged jumps past 50).
    REDIS_CLUSTER_SELFHEAL_INFLIGHT_THRESHOLD: z.coerce.number().default(50),
    // The inflight count must stay ABOVE the threshold continuously for THIS long before a
    // reconnect fires. A transient spike (a slow batch, a brief failover) drops back under
    // the threshold within the window and resets the timer → no reconnect. A genuine wedge
    // stays pinned. 20s is long enough to exclude every transient we've seen and short
    // enough to clear a wedge well inside a human's reaction time.
    REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS: z.coerce.number().default(20000),
    // Minimum time between two self-heal reconnects. At most one reconnect per cooldown,
    // so even a flapping wedge can't drive a reconnect storm (each reconnect rejects the
    // pod's in-flight cluster commands, which the fail-open/fail-soft paths absorb). 60s.
    REDIS_CLUSTER_SELFHEAL_COOLDOWN_MS: z.coerce.number().default(60000),
    // How often the watchdog samples inflight. Cheap (one gauge read), so a tight 1s
    // sample keeps the sustained-window measurement accurate without overhead.
    REDIS_CLUSTER_SELFHEAL_CHECK_INTERVAL_MS: z.coerce.number().default(1000),
    // ── DEADLINE-HIT TRIGGER (the sawtooth-immune self-heal signal) ──────────────────
    //
    // The inflight-continuity trigger above CANNOT fire during a real half-open park: the
    // per-command deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS = 15s) mass-rejects the parked
    // commands every ~15s, so inflight SAWTOOTHS to ~0 and the sustained-breach timer
    // (REDIS_CLUSTER_SELFHEAL_SUSTAINED_MS = 20s > 15s) resets before it ever accumulates.
    // Confirmed live: 21 pods wedged to inflight≈200 for 6–12 min with
    // civitai_app_redis_selfheal_reconnect_total = 0 across the whole fleet.
    //
    // The fix triggers self-heal on a signal the deadline-drain can't erase: the RATE of
    // deadline TIMEOUTS. A healthy cluster client hits the 15s deadline ZERO times in any
    // window (healthy p99 ≈ 23ms); a half-open client hits it on ~every command (the drains
    // ARE the hits). So "N deadline timeouts within W ms" is a monotonic, sawtooth-immune
    // "this client is wedged" signal that fires within seconds of a park — well inside the
    // ~60s kubelet readiness-shed threshold, instead of never.
    //
    // Default 10 hits within 20000ms (20s): a half-open pool serving even modest traffic
    // produces dozens–hundreds of 15s deadline rejects in a 20s window, so 10 trips fast;
    // a one-off transient slow command (a single hit) never reaches 10. 0 disables this
    // trigger (falls back to the inflight-continuity path only).
    REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_THRESHOLD: z.coerce.number().default(10),
    REDIS_CLUSTER_SELFHEAL_DEADLINE_HIT_WINDOW_MS: z.coerce.number().default(20000),
    // A cluster command whose OBSERVED settle duration reaches this many ms counts as a wedge hit
    // (recordClusterCommandSettle, wired from instrumentCommands' done() — the SAME settle-time
    // observation as redis_command_duration_seconds). 2026-07-06: the deadline-hit trigger used to
    // key off withCommandDeadline's onTimeout (the deadline REAP), which never fires when slow
    // commands COMPLETE in the 10–15s band under the reaper (or settle on their own past it), so the
    // ring stayed empty and self-heal 0-fired during a fleet wedge. Set BELOW the command deadline
    // (15s) so it catches the invisible 10–15s band and works even if the reaper is disabled;
    // healthy p99 ≈ 23ms so 10s is ~400× p99. <= 0 disables slow-settle recording. MUST be <
    // REDIS_CLUSTER_COMMAND_TIMEOUT_MS (enforced in the superRefine below).
    REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS: z.coerce.number().default(10000),
    // ── PER-POD RECONNECT JITTER (fleet-stampede brake) ──────────────────────────────
    //
    // The self-heal trigger fires within seconds of a wedge. That's the point for a pod-LOCAL
    // wedge, but it has a correlated-failure edge: if next-redis-cluster ITSELF has a genuine
    // slow event (master failover, network blip), EVERY pod's cluster commands cross the
    // slow-settle threshold at once → the whole fleet (~80-100 pods) trips the trigger inside
    // the same ~1s watchdog tick and fires forceClusterReconnect (destroy() + connect())
    // simultaneously → a connection thundering-herd against an already-unhealthy cluster, right
    // when it can least absorb it.
    //
    // This spreads each pod's reconnect over a random [0, jitter) delay AFTER the trigger
    // decision (the cooldown/single-flight guards are taken up front, so the jitter cannot
    // queue a second reconnect or restart the cooldown). A synchronized fleet event then
    // smears its reconnects across the jitter window instead of all landing on one tick.
    // 0 disables jitter (reconnect fires immediately — the prior behavior). WIDENED to 3000ms
    // (was 1000) for the settle-time trigger: it fires on a BROADER envelope than the old
    // reaper-only signal (any command completing >= REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS = 10s,
    // not just those reaped at 15s), so a >10s cluster event can trip ~100 pods on nearly the
    // same tick; 1s was too thin to de-correlate that many destroy()+connect()s. 3s still keeps a
    // single-pod heal well inside the ~60s kubelet readiness-shed window (3–5s reasonable).
    REDIS_CLUSTER_SELFHEAL_RECONNECT_JITTER_MS: z.coerce.number().default(3000),

    // ── CLUSTER ROUTING RETRY-AFTER-REDISCOVER (the topology-churn 500 wave) ─────────
    //
    // During ANY next-redis-cluster topology change (rolling update / node failover /
    // scale event) the node-redis cluster slot map is transiently inconsistent and the
    // client throws FLEET-WIDE, BEFORE the command is dispatched to any node:
    //   TypeError: Cannot read properties of undefined (reading 'replicas')
    //     at RedisClusterSlots.getSlotRandomNode (@redis/client@5.8.3 cluster-slots.js:342)
    // Measured live during a rolling update: 1,696 throws in 15 min across ~90 pods →
    // user-facing HTTP 500s on GENERAL cache READ paths (tag.getAll, image.getGenerationData,
    // hiddenPreferences.getHidden, …). The cluster stays cluster_state=ok; it is purely the
    // client mishandling churn, and the wave self-clears in ~1–2 min as topology settles.
    //
    // This is a genuine gap #2665 doesn't cover: the self-heal watchdog (FIX #1) only fires
    // on a SUSTAINED inflight pin (the HANG-wedge), not this IMMEDIATE fail-fast throw; and
    // the metric-write fail-soft (FIX #3) covers only the write/lock path, not these reads.
    //
    // KEY SAFETY ARGUMENT: getSlotRandomNode throws during NODE SELECTION — the command never
    // reached a node, so a bounded retry-after-rediscover is safe for ALL commands, reads AND
    // writes/mutations (zero double-execution risk — nothing executed). After exhausting the
    // retries the ORIGINAL error is RE-THROWN (no silent swallow — current failure mode
    // preserved for a genuinely persistent break). Cluster client ONLY (wired at the cluster
    // `_execute` chokepoint; the single-node sysRedis client is never wrapped — a blanket
    // sys-client change caused the #2556/#2586 wedge). NO money/entitlement blast radius
    // (cache/routing only; money + entitlement live in Postgres + the sysRedis client).
    //
    // ON by default; REDIS_CLUSTER_ROUTING_RETRY_ENABLED=false is a single-flip kill-switch
    // that restores today's exact behavior (one attempt, throw on a routing error).
    REDIS_CLUSTER_ROUTING_RETRY_ENABLED: z.preprocess(
      // default true; only the literal string 'false' disables it (mirrors the SELFHEAL flag)
      (x) => x !== 'false',
      z.boolean().default(true)
    ),
    // Max RETRIES after the initial attempt. The transient window is ~1–2 min cluster-wide but
    // any single pod's command only needs the map to settle for ITS slot — 2 retries with the
    // backoff below clears the vast majority within ~200ms; more would just pile latency on a
    // genuinely-persistent break that's going to re-throw anyway. 0 disables retry (pass-through).
    REDIS_CLUSTER_ROUTING_RETRY_MAX: z.coerce.number().default(2),
    // Backoff before the 1st / 2nd retry (ms). This IS the settle window: the rediscover between
    // attempts is a best-effort FIRE-AND-FORGET nudge (triggerTopologyRediscovery returns undefined,
    // not awaited to completion), so it's this backoff — not the rediscover call — that gives the
    // in-flight, single-flighted slot-map refresh a beat to land before the retry. 50ms then 150ms.
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MS: z.coerce.number().default(50),
    REDIS_CLUSTER_ROUTING_RETRY_BACKOFF_MAX_MS: z.coerce.number().default(150),

    // Upper bound (ms) on a single ClickHouse image-metrics read in the feed/SSR
    // hot path (getImageMetricsObject). The @clickhouse/client default
    // request_timeout is 30000ms, so a saturated/cold-cache-miss metric read would
    // otherwise park ~30s and blow the SSR deadline (the surrounding try/catch
    // CANNOT catch a hang). The CH metric query (entityMetricDailyAgg_v2) is
    // genuinely slow — ~4.6s p50 / ~11s p99 — so on a cold cache miss the timeout
    // fires and we fail SOFT to empty metrics, yielding TRANSIENT zeros. That
    // self-heals: the un-aborted background fetch fills Redis ~4.6s later, so the
    // next render serves real numbers. Callers already treat missing ids as null
    // metrics. The durable fix is the slow CH query itself (out of scope here).
    // Default 3000ms — snappy SSR over correctness on the first cold render.
    // .int().positive() so a misconfigured 0 / negative fails fast at BOOT instead
    // of silently disabling the guard (withTimeoutFallback passes through unbounded
    // when ms<=0 → the exact ~30s hang this exists to prevent, with no signal).
    CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']),
    NEXTAUTH_SECRET: z.string(),
    NEXTAUTH_URL: z.preprocess(
      // This makes Vercel deployments not fail if you don't set NEXTAUTH_URL
      // Since NextAuth automatically uses the VERCEL_URL if present.
      (str) => process.env.VERCEL_URL ?? str,
      // VERCEL_URL doesnt include `https` so it cant be validated as a URL
      process.env.VERCEL ? z.string() : z.url()
    ),
    // Optional cookie domain override for cross-subdomain session sharing (e.g., PR previews)
    // When set, session cookies will use this domain (e.g., ".civitaic.com") instead of the hostname
    NEXTAUTH_COOKIE_DOMAIN: z.string().optional(),
    CLICKHOUSE_HOST: isProd ? z.string() : z.string().optional(),
    CLICKHOUSE_USERNAME: isProd ? z.string() : z.string().optional(),
    CLICKHOUSE_PASSWORD: isProd ? z.string() : z.string().optional(),
    CLICKHOUSE_TRACKER_URL: z.url().optional(),
    // OAuth LOGIN provider secrets now live ONLY in the hub (apps/auth) — the spoke fetches the enabled-provider
    // list from GET {hub}/api/auth/providers and never holds login secrets. Discord's creds REMAIN here because
    // the Discord ROLE-CONNECTION integration (src/server/integrations/discord.ts) uses them — that's a separate
    // feature from login, not a civitai sign-in secret.
    DISCORD_CLIENT_ID: z.string(),
    DISCORD_CLIENT_SECRET: z.string(),
    DISCORD_BOT_TOKEN: z.string().optional(),
    DISCORD_GUILD_ID: z.string().optional(),
    DISCORD_WEBHOOK_MOD_ALERTS: z.string().optional(),
    EMAIL_HOST: z.string(),
    EMAIL_PORT: z.preprocess((x) => parseInt(String(x)), z.number()),
    EMAIL_SECURE: zc.booleanString,
    EMAIL_USER: z.string(),
    EMAIL_PASS: z.string(),
    EMAIL_FROM: z.string(),
    S3_UPLOAD_KEY: z.string(),
    S3_UPLOAD_SECRET: z.string(),
    S3_UPLOAD_REGION: z.string(),
    S3_UPLOAD_ENDPOINT: z.url(),
    S3_UPLOAD_BUCKET: z.string(),
    // Legacy DO Spaces image credentials — only used for deleting old images
    S3_IMAGE_UPLOAD_KEY: z.string().optional(),
    S3_IMAGE_UPLOAD_SECRET: z.string().optional(),
    S3_IMAGE_UPLOAD_REGION: z.string().optional(),
    S3_IMAGE_UPLOAD_ENDPOINT: z.string().optional(),
    S3_IMAGE_UPLOAD_BUCKET: z.string().optional(),
    S3_IMAGE_FORCE_PATH_STYLE: zc.booleanString.optional().default(false),
    S3_IMAGE_CACHE_BUCKET: z.string().default(''),
    S3_IMAGE_CACHE_BUCKET_OLD: z.string().optional(),
    CF_ACCOUNT_ID: z.string().optional(),
    CF_IMAGES_TOKEN: z.string().optional(),
    CF_API_TOKEN: z.string().optional(),
    CF_ZONE_ID: z.string().optional(),
    JOB_TOKEN: z.string(),
    WEBHOOK_URL: z.url().optional(),
    WEBHOOK_TOKEN: z.string(),
    UNAUTHENTICATED_DOWNLOAD: zc.booleanString,
    UNAUTHENTICATED_LIST_NSFW: zc.booleanString,
    LOGGING: commaDelimitedStringArray(),
    IMAGE_SCANNING_ENDPOINT: isProd ? z.string() : z.string().optional(),
    IMAGE_SCANNING_CALLBACK: z.string().optional(),
    TEXT_MODERATION_CALLBACK: z.string().optional(),
    IMAGE_SCANNING_MODEL: z.string().optional(),
    IMAGE_SCANNING_RETRY_DELAY: z.coerce.number().default(5),
    IMAGE_SCANNER_NEW: zc.booleanString.default(false),
    DELIVERY_WORKER_ENDPOINT: z.string().optional(),
    DELIVERY_WORKER_TOKEN: z.string().optional(),
    STORAGE_RESOLVER_ENDPOINT: z.string().optional(), // URL for storage-resolver microservice
    STORAGE_RESOLVER_AUTH: z.string().optional(), // Basic auth credentials (username:password)
    TRPC_ORIGINS: commaDelimitedStringArray().default([]),
    ORCHESTRATOR_ENDPOINT: isProd ? z.url() : z.url().optional(),
    ORCHESTRATOR_MODE: z.string().default('dev'),
    ORCHESTRATOR_ACCESS_TOKEN: z.string().default(''),
    AXIOM_TOKEN: z.string().optional(),
    AXIOM_ORG_ID: z.string().optional(),
    AXIOM_DATASTREAM: z.string().optional(),
    SEARCH_HOST: z.url().optional(),
    SEARCH_API_KEY: z.string().optional(),
    METRICS_SEARCH_HOST: z.url().optional(),
    METRICS_SEARCH_API_KEY: z.string().optional(),
    // Per-call Meilisearch timeout in ms. Calls wrapped via withMeili() fail
    // fast with MeiliCallTimeoutError once exceeded, instead of hanging until
    // Traefik's 30s router timeout fires. Default tuned for the image feed
    // hot path (typical P99 ~700ms under healthy load).
    MEILI_CALL_TIMEOUT_MS: z.coerce.number().optional().default(2500),
    // Server-side deadline for fetchDocumentsAbortable in ms. Distinct from
    // MEILI_CALL_TIMEOUT_MS — that one wraps SDK calls via withMeili();
    // this one is the local AbortController timer on the raw fetch path
    // (image:meili:http span). Generous default (5_000) so healthy
    // /documents/fetch calls complete cleanly; tunable down at runtime if
    // the backend tightens up, or up if a brownout needs more headroom
    // without a code redeploy. Defensive cap: prevents pods from holding
    // event-loop slots for the Node default (~30s) when -new goes slow.
    MEILI_FETCH_TIMEOUT_MS: z.coerce.number().optional().default(5000),
    // Per-pod cap on in-flight Meilisearch calls wrapped via withMeili().
    // When saturated, additional calls fail fast with MeiliCallTimeoutError
    // rather than queueing forever and pressuring the event loop.
    MEILI_CALL_CONCURRENCY: z.coerce.number().optional().default(50),
    // Per-backend circuit breaker (see src/server/meilisearch/client.ts). If
    // `MEILI_CIRCUIT_TRIP_THRESHOLD` MeiliCallTimeoutErrors accumulate within
    // `MEILI_CIRCUIT_WINDOW_SECONDS` on a backend, the circuit OPENs and all
    // calls fail at 0ms (no acquire, no setTimeout, no request) for
    // `MEILI_CIRCUIT_COOLDOWN_SECONDS`, then transitions to HALF_OPEN for a
    // single trial request. This eliminates the ~125 worker-seconds of
    // accumulated 2.5s waits per pod per cycle during chronic brownouts —
    // the mechanism that bled the api-primary pool past kubelet TCP probe
    // timeout on 2026-05-30.
    // .int().min(1) on all three: a blank env value coerces to NaN under
    // z.coerce.number(), which silently makes the >= comparison false →
    // breaker disabled. Zero values would either trip on first failure
    // (threshold=0), prune all failures immediately (window=0), or skip
    // cooldown entirely (cooldown=0). Reject all three at boot.
    MEILI_CIRCUIT_TRIP_THRESHOLD: z.coerce.number().int().min(1).optional().default(10),
    MEILI_CIRCUIT_WINDOW_SECONDS: z.coerce.number().int().min(1).optional().default(30),
    MEILI_CIRCUIT_COOLDOWN_SECONDS: z.coerce.number().int().min(1).optional().default(30),
    PODNAME: z.string().optional(),
    INTEGRATION_TOKEN: z.string().optional(),
    NEWSLETTER_ID: z.string().optional(),
    NEWSLETTER_KEY: z.string().optional(),
    BUZZ_ENDPOINT: isProd ? z.url() : z.url().optional(),
    SIGNALS_ENDPOINT: isProd ? z.url() : z.url().optional(),
    // The in-repo notifications app (apps/notifications) — the monolith creates/reads/marks notifications
    // through it via @civitai/notifications rather than touching the notification DB directly.
    NOTIFICATIONS_ENDPOINT: isProd ? z.url() : z.url().optional(),
    // Prod-required + non-empty: the app disables its auth gate on an empty token, so a blank value here
    // would produce an unauthenticated producer API. Fail-fast at monolith boot instead.
    NOTIFICATIONS_TOKEN: isProd ? z.string().min(1) : z.string().optional(),
    // Per-call signals timeout in ms. Calls wrapped via withSignals() fail
    // fast with SignalsCallTimeoutError once exceeded, instead of hanging
    // until Traefik's 30s router timeout fires. Default tuned for signals
    // normal latency (higher than Meili due to Orleans grain init).
    SIGNALS_CALL_TIMEOUT_MS: z.coerce.number().int().min(1).optional().default(5000),
    // Per-pod cap on in-flight signals HTTP calls wrapped via withSignals().
    // When saturated, additional calls fail fast with SignalsCallTimeoutError
    // rather than queueing forever and pressuring the event loop.
    SIGNALS_CALL_CONCURRENCY: z.coerce.number().int().min(1).optional().default(30),
    // Single-backend circuit breaker for signals (see src/server/signals/wrapper.ts).
    // If `SIGNALS_CIRCUIT_TRIP_THRESHOLD` SignalsCallTimeoutErrors accumulate
    // within `SIGNALS_CIRCUIT_WINDOW_SECONDS`, the circuit OPENs and all calls
    // fail at 0ms (no acquire, no setTimeout, no request) for
    // `SIGNALS_CIRCUIT_COOLDOWN_SECONDS`, then transitions to HALF_OPEN for a
    // single trial request. This is the load-shed mechanism that protects the
    // event loop from accumulated wait time during signals chronic brownouts —
    // the failure mode that drove the 2026-05-30 api-primary SIGKILL cascade
    // (signals Traefik P99 pegged at 30s router timeout). Window is longer than
    // Meili's (30→60s) because signals normal latency is higher.
    // .int().min(1) on all three: a blank env value coerces to NaN under
    // z.coerce.number(), which silently makes the >= comparison false →
    // breaker disabled. Reject all three at boot.
    SIGNALS_CIRCUIT_TRIP_THRESHOLD: z.coerce.number().int().min(1).optional().default(10),
    SIGNALS_CIRCUIT_WINDOW_SECONDS: z.coerce.number().int().min(1).optional().default(60),
    SIGNALS_CIRCUIT_COOLDOWN_SECONDS: z.coerce.number().int().min(1).optional().default(30),
    CACHE_DNS: zc.booleanString,
    MINOR_FALLBACK_SYSTEM: zc.booleanString,
    CSAM_UPLOAD_KEY: z.string().default(''),
    CSAM_UPLOAD_SECRET: z.string().default(''),
    CSAM_BUCKET_NAME: z.string().default(''),
    CSAM_UPLOAD_REGION: z.string().default(''),
    CSAM_UPLOAD_ENDPOINT: z.string().default(''),
    NCMEC_URL: z.string().optional(),
    NCMEC_USERNAME: z.string().default(''),
    NCMEC_PASSWORD: z.string().default(''),
    DIRNAME: z.string().optional(),
    IMAGE_QUERY_CACHING: zc.booleanString,
    POST_QUERY_CACHING: zc.booleanString,
    EXTERNAL_MODERATION_ENDPOINT: z.url().optional(),
    EXTERNAL_MODERATION_TOKEN: z.string().optional(),
    EXTERNAL_MODERATION_CATEGORIES: commaDelimitedStringObject().optional(),
    EXTERNAL_MODERATION_THRESHOLD: z.coerce.number().optional().default(0.5),
    // Hard request timeout (ms) for the external moderation call. Bounds the
    // fail-soft path: when the moderation gateway is slow/hanging (503/504 waves),
    // the fetch is aborted at this deadline instead of parking the whole generation
    // submission for undici's ~300s default. See src/server/integrations/moderation.ts.
    // `.int().min(100).max(60000).catch(5000)` so a missing/empty/0/negative/garbage
    // value falls back to 5000 rather than (a) crashing boot or (b) coercing to 0 →
    // AbortSignal.timeout(0) → aborting every call → SILENTLY disabling external
    // moderation (the dangerous failure for a trust-and-safety control). The bounds
    // (#2734) reject both ends of the danger range: a tiny value (<100ms) would abort
    // before moderation can respond → skips moderation, and a huge value (e.g. 1e10 →
    // ~116-day timeout) re-introduces the unbounded-park failure the deadline exists
    // to prevent. Any out-of-range value falls back to 5000.
    EXTERNAL_MODERATION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).catch(5000),
    BLOCKED_IMAGE_HASH_CHECK: zc.booleanString.optional().default(false),
    MODERATION_KNIGHT_TAGS: commaDelimitedStringArray().default([]),

    CLAVATA_ENDPOINT: z.url().optional(),
    CLAVATA_TOKEN: z.string().optional(),
    CLAVATA_POLICY: z.string().optional(),

    TOKEN_LOGINS: commaDelimitedStringObject().optional(),

    EXTERNAL_IMAGE_SCANNER: z.string().optional(),
    CLAVATA_SCAN: z.enum(['off', 'shadow', 'active']).default('shadow'),
    MINOR_SCANNER: z.enum(['custom', 'hive']).optional().catch(undefined),
    HIVE_VISUAL_TOKEN: z.string().optional(),

    ALT_ORCHESTRATION_ENDPOINT: z.url().optional(),
    ALT_ORCHESTRATION_TOKEN: z.string().optional(),
    ALT_ORCHESTRATION_TIMEFRAME: z
      .preprocess(
        (value) => {
          if (typeof value !== 'string') return null;

          const [start, end] = value.split(',').map((x) => new Date(x));
          return { start, end };
        },
        z.object({
          start: z.date().optional(),
          end: z.date().optional(),
        })
      )
      .optional(),
    IS_DATAPACKET: zc.booleanString.default(false),
    REPLICATION_LAG_DELAY: z.coerce.number().default(0),
    RECAPTCHA_PROJECT_ID: z.string(),
    AIR_WEBHOOK: z.url().optional(),
    AIR_PAYMENT_LINK_ID: z.string().optional(),
    PAYPAL_API_URL: z.url().optional(),
    PAYPAL_SECRET: z.string().optional(),
    PAYPAL_CLIENT_ID: z.string().optional(),
    S3_VAULT_BUCKET: z.string().optional(),
    HEALTHCHECK_TIMEOUT: z.coerce.number().optional().default(1500),
    // Comma-delimited check names to skip in /api/health (e.g. "searchMetrics").
    // Static counterpart to the runtime sysRedis DISABLED_HEALTHCHECKS list.
    HEALTHCHECK_DISABLED: commaDelimitedStringArray().optional(),
    FRESHDESK_JWT_SECRET: z.string().optional(),
    FRESHDESK_JWT_URL: z.string().optional(),
    FRESHDESK_DOMAIN: z.string().optional(),
    FRESHDESK_TOKEN: z.string().optional(),
    FRESHDESK_AGENT_ID: z.coerce.number().optional(),
    UPLOAD_PROHIBITED_EXTENSIONS: commaDelimitedStringArray().optional(),
    POST_INTENT_DETAILS_HOSTS: z.preprocess(stringToArray, z.array(z.url()).optional()),
    CHOPPED_TOKEN: z.string().optional(),
    TIER_METADATA_KEY: z.string().default('tier'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
    STRIPE_DONATE_ID: z.string().optional(),
    PADDLE_SECRET_KEY: z.string().optional(),
    PADDLE_WEBHOOK_SECRET: z.string().optional(),
    CLOUDFLARE_TURNSTILE_SECRET: z.string().optional(),
    CF_INVISIBLE_TURNSTILE_SECRET: z.string().optional(),
    CF_MANAGED_TURNSTILE_SECRET: z.string().optional(),
    CONTENT_SCAN_ENDPOINT: isProd ? z.string() : z.string().optional(),
    CONTENT_SCAN_CALLBACK_URL: z.string().optional(),
    CONTENT_SCAN_MODEL: z.string().optional(),
    // TIPALTI. It uses a lot of little env vars, so we group them here.
    // iFrame Related:
    TIPALTI_PAYER_NAME: z.string().optional(),
    TIPALTI_PAYEE_DASHBOARD_URL: z.string().optional(),
    TIPALTI_IFRAME_KEY: z.string().optional(),
    TIPALTI_WEBTOKEN_SECRET: z.string().optional(),

    // API Related:
    TIPALTI_API_URL: z.string().optional(),
    TIPALTI_API_CLIENT_ID: z.string().optional(),
    TIPALTI_API_SECRET: z.string().optional(),
    TIPALTI_API_CODE_VERIFIER: z.string().optional(),
    TIPALTI_API_REFRESH_TOKEN: z.string().optional(),
    TIPALTI_API_TOKEN_URL: z.string().optional(),

    // OpenAI
    OPENAI_API_KEY: z.string().optional(),

    // OpenRouter (unified LLM API)
    OPENROUTER_API_KEY: z.string().optional(),
    // Youtube related:
    YOUTUBE_APP_CLIENT_ID: z.string().optional(),
    YOUTUBE_APP_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_VIDEO_UPLOAD_URL: z.string().optional(),

    // Vimeo related:
    VIMEO_ACCESS_TOKEN: z.string().optional(),
    VIMEO_SECRET: z.string().optional(),
    VIMEO_CLIENT_ID: z.string().optional(),
    VIMEO_VIDEO_UPLOAD_URL: z.string().optional(),

    // Creator Program Related:
    CREATOR_POOL_TAXES: z.coerce.number().optional(),
    CREATOR_POOL_PORTION: z.coerce.number().optional(),
    CREATOR_POOL_FORECAST_PORTION: z.coerce.number().optional().default(50),

    // NOWPayments Related:

    // API Related:
    NOW_PAYMENTS_API_URL: z.string().optional(),
    NOW_PAYMENTS_API_KEY: z.string().optional(),
    NOW_PAYMENTS_IPN_KEY: z.string().optional(),
    NOW_PAYMENTS_EMAIL: z.string().optional(),
    NOW_PAYMENTS_PASSWORD: z.string().optional(),
    NOW_PAYMENTS_PAYOUT_ADDRESS: z.string().optional(),
    NOWPAYMENTS_IPN_URL: z.string().optional(), // Override IPN callback URL (e.g., webhook.site for dev)

    // Coinbase Related:
    COINBASE_API_URL: z.string().optional(),
    COINBASE_API_KEY: z.string().optional(),
    COINBASE_WEBHOOK_SECRET: z.string().optional(),

    // Coinbase developer related:
    CDP_APP_ID: z.string().optional(),
    CDP_API_KEY_ID: z.string().optional(),
    CDP_API_KEY_SECRET: z.string().optional(),
    CDP_WALLET_SECRET: z.string().optional(),
    CDP_NETWORK: z.string().optional(),
    CDP_USDC_ADDRESS: z.string().optional(),
    CDP_PAYMASTER_URL: z.string().optional(),
    CDP_CIVITAI_ADDRESS: z.string().optional(),

    // EmerchantPay Related:
    EMERCHANTPAY_WPF_URL: z.string().optional(),
    EMERCHANTPAY_USERNAME: z.string().optional(),
    EMERCHANTPAY_PASSWORD: z.string().optional(),
    EMERCHANTPAY_WEBHOOK_SECRET: z.string().optional(),

    // Shopify merch store — Blue Buzz reward loop. SHOPIFY_SHOP_DOMAIN is the
    // *.myshopify.com admin domain (e.g. ff1592-5.myshopify.com). Webhook secret
    // verifies orders/* HMAC. Admin auth: the custom app uses the client_credentials
    // grant (CLIENT_ID + CLIENT_SECRET → short-lived token); set SHOPIFY_ADMIN_TOKEN
    // instead only if using a static store custom-app token.
    SHOPIFY_SHOP_DOMAIN: z.string().optional(),
    SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
    SHOPIFY_CLIENT_ID: z.string().optional(),
    SHOPIFY_CLIENT_SECRET: z.string().optional(),
    SHOPIFY_ADMIN_TOKEN: z.string().optional(),

    FLIPT_URL: z.string(),
    FLIPT_FETCHER_SECRET: z.string(),
    FLIPT_DEPLOYMENT_ID: z.string().optional(),

    // B2 Upload — model + training files route to B2 whenever this endpoint is
    // configured (no Flipt flag; routing is gated solely on the presence of this
    // var). Rollback note: unsetting this is now the ONLY lever to force model
    // uploads off B2 — it also disables the training-upload B2 path (shared gate)
    // and requires a redeploy. There is no per-user/runtime kill switch anymore.
    S3_UPLOAD_B2_ENDPOINT: z.string().optional(),
    S3_UPLOAD_B2_ACCESS_KEY: z.string().optional(),
    S3_UPLOAD_B2_SECRET_KEY: z.string().optional(),
    S3_UPLOAD_B2_BUCKET: z.string().optional(),
    S3_UPLOAD_B2_REGION: z.string().optional(),

    // B2 Upload — media/images (gated by Flipt flag B2_IMAGE_UPLOAD)
    S3_IMAGE_B2_ENDPOINT: z.string().optional(),
    S3_IMAGE_B2_ACCESS_KEY: z.string().optional(),
    S3_IMAGE_B2_SECRET_KEY: z.string().optional(),
    S3_IMAGE_B2_BUCKET: z.string().optional(),
    S3_IMAGE_B2_REGION: z.string().optional(),

    // Storage resolver internal API (for registering B2 uploads)
    STORAGE_RESOLVER_INTERNAL_URL: z.string().optional(),
    STORAGE_RESOLVER_INTERNAL_TOKEN: z.string().optional(),

    // Image-cacher invalidation endpoint (cluster-internal). Used to clear
    // image-cacher's Redis L2 cache + Cloudflare cache after we delete an
    // image from B2. Optional — if unset, invalidation is skipped.
    IMAGE_CACHER_URL: z.url().optional(),

    // BitDex
    BITDEX_URL: z.string().optional().default(''),

    // Color environment domains (server-only; delivered to client via AppProvider).
    // SERVER_DOMAIN_<COLOR> is the canonical host used for all outbound URLs.
    // SERVER_DOMAIN_<COLOR>_ALIASES is a comma-separated list of additional hosts
    // that resolve to the same color on inbound requests. Aliases never appear in
    // outbound URLs and do not inherit per-color OAuth credentials.
    SERVER_DOMAIN_GREEN: z.string().optional(),
    SERVER_DOMAIN_GREEN_ALIASES: z.string().optional(),
    SERVER_DOMAIN_BLUE: z.string().optional(),
    SERVER_DOMAIN_BLUE_ALIASES: z.string().optional(),
    SERVER_DOMAIN_RED: z.string().optional(),
    SERVER_DOMAIN_RED_ALIASES: z.string().optional(),

    // App Blocks (Phase 1) — RSA keypair for block-scoped JWT issuance + JWKS.
    // BLOCK_TOKEN_PRIVATE_KEY signs tokens; BLOCK_TOKEN_PUBLIC_KEY is served via
    // /api/v1/block-tokens/jwks. BLOCK_TOKEN_PUBLIC_KEY_NEXT is set during the
    // rotation window so the JWKS endpoint publishes both keys (and verifyBlockToken
    // accepts signatures from either) for one full token lifetime. BLOCK_ALLOWED_ORIGINS
    // is the CORS allow-list (comma-separated). All optional so the app boots before
    // App Blocks rolls out; the token endpoints fail-closed if the signing key is missing.
    BLOCK_TOKEN_PRIVATE_KEY: z.string().optional(),
    BLOCK_TOKEN_PUBLIC_KEY: z.string().optional(),
    BLOCK_TOKEN_PUBLIC_KEY_NEXT: z.string().optional(),
    BLOCK_ALLOWED_ORIGINS: z.string().optional(),

    // App Blocks W2 (apps-as-repos). Optional so envs that don't run the
    // platform layer (PR previews without apps-pipeline wiring) still boot.
    //
    // FORGEJO_BASE_URL          public root, e.g. https://forgejo.civitai.com
    // FORGEJO_ADMIN_TOKEN       Forgejo personal access token (admin) — used
    //                           by civitai-web to create repos / webhooks
    // FORGEJO_WEBHOOK_SECRET    HMAC shared secret between Forgejo → webhook
    // BLOCK_BUILD_CALLBACK_SECRET   HMAC shared secret between Tekton → callback
    // APPS_TEKTON_TRIGGER_URL   HTTP endpoint that creates PipelineRuns on
    //                           dc-02-a (the app-blocks-trigger receiver,
    //                           reached via the VPN proxy on dp-1). Example:
    //                           http://wireguard-proxy-service.civitai-submodel-proxy.svc.cluster.local:8088/trigger-build
    // APPS_TEKTON_TRIGGER_SECRET   HMAC shared secret between civitai-web and
    //                           the app-blocks-trigger receiver. 32-byte hex.
    // APPS_KUBE_NAMESPACE       civitai-apps (where apply Jobs are created
    //                           on dp-1). Defaults to civitai-apps.
    // APPS_DOMAIN               public per-app subdomain root, e.g.
    //                           civit.ai — used to build iframe.src
    //                           validation in the webhook. Defaults to civit.ai
    //                           since CF universal SSL covers *.civit.ai
    //                           single-level wildcard for free.
    FORGEJO_BASE_URL: z.string().url().optional(),
    // Browser-facing public URL for Forgejo — distinct from FORGEJO_BASE_URL
    // because the latter points at the cluster-internal service so civitai-web's
    // API + webhook calls don't loop through Cloudflare + oauth2-proxy. The
    // mod-review UI link in /apps/review uses this one. Defaults to the
    // production hostname; PR previews can override but won't normally need to.
    FORGEJO_PUBLIC_URL: z.string().url().default('https://forgejo.civitai.com'),
    FORGEJO_ADMIN_TOKEN: z.string().optional(),
    FORGEJO_WEBHOOK_SECRET: z.string().optional(),
    // Client-side abort timeouts for Forgejo API calls. The cheap metadata calls
    // (get repo/version, add collaborator, list tree, branch lookup) are
    // sub-second and use FORGEJO_API_TIMEOUT_MS so an in-cluster reachability
    // problem surfaces fast. The BUNDLE COMMIT/PUSH path (first-time review-repo
    // create + a single multi-file commit of every bundle file) is genuinely slow
    // for a real app — gen-matrix is ~888 files — so it gets the much larger
    // FORGEJO_COMMIT_TIMEOUT_MS. A 15s ceiling on the commit aborted real submits
    // with "The operation was aborted due to timeout"; 120s gives headroom.
    FORGEJO_API_TIMEOUT_MS: z.coerce.number().default(15000),
    FORGEJO_COMMIT_TIMEOUT_MS: z.coerce.number().default(120000),
    // F6 — optional second HMAC secret accepted during a zero-downtime rotation.
    // verifyForgejoSignature (git-push.ts) / verifySignature (build-callback.ts)
    // accept a signature valid under EITHER the current or the _NEXT secret. When
    // unset, behaviour is identical to single-secret. Pairs with the talos-side
    // APPS_TEKTON_TRIGGER_SECRET_NEXT to complete the three-secret rotation.
    FORGEJO_WEBHOOK_SECRET_NEXT: z.string().optional(),
    BLOCK_BUILD_CALLBACK_SECRET: z.string().optional(),
    BLOCK_BUILD_CALLBACK_SECRET_NEXT: z.string().optional(),
    APPS_TEKTON_TRIGGER_URL: z.string().url().optional(),
    APPS_TEKTON_TRIGGER_SECRET: z.string().optional(),
    // MOD REVIEW SANDBOX (#2831) — endpoint on the SAME app-blocks-trigger
    // receiver that creates a review-mode PipelineRun (clones the in-review repo,
    // builds ghcr.io/civitai/app-block-review-<slug>:<sha>, posts to
    // review-build-callback). HMAC-signed with the SAME APPS_TEKTON_TRIGGER_SECRET
    // (no new secret). OPTIONAL — when unset, triggerReviewBuild derives it from
    // APPS_TEKTON_TRIGGER_URL by swapping the trailing `/trigger-build` segment
    // for `/trigger-review-build`, so a typical deploy needs no extra env. Example:
    // http://wireguard-proxy-service.civitai-submodel-proxy.svc.cluster.local:8088/trigger-review-build
    APPS_TEKTON_REVIEW_TRIGGER_URL: z.string().url().optional(),
    APPS_KUBE_NAMESPACE: z.string().default('civitai-apps'),
    APPS_DOMAIN: z.string().default('civit.ai'),
    // Base URL of the verify-runner screenshot service (warm Playwright Chromium)
    // used to autogenerate a marketplace screenshot for an approved App Block that
    // shipped no publisher screenshots. In-cluster service (devpod-devops ns), e.g.
    // http://verify-runner.devpod-devops.svc.cluster.local:8080. OPTIONAL — when
    // unset, autogeneration is silently skipped (best-effort; never blocks deploy).
    BLOCK_SCREENSHOT_RUNNER_URL: z.string().url().optional(),

    // App Blocks W1 (publish-request flow). S3-compatible storage for
    // dev-uploaded ZIP bundles. Production points at ssd-minio-backups
    // MinIO with credentials scoped to the app-block-bundles bucket only.
    // All optional so envs without the publish-request feature still boot.
    //
    // BUNDLE_S3_ENDPOINT             e.g. http://minio.minio-ssd-backups.svc.cluster.local
    // BUNDLE_S3_BUCKET               e.g. app-block-bundles
    // BUNDLE_S3_ACCESS_KEY_ID        scoped service-account key
    // BUNDLE_S3_SECRET_ACCESS_KEY    matching secret
    BUNDLE_S3_ENDPOINT: z.string().url().optional(),
    BUNDLE_S3_BUCKET: z.string().optional(),
    BUNDLE_S3_ACCESS_KEY_ID: z.string().optional(),
    BUNDLE_S3_SECRET_ACCESS_KEY: z.string().optional(),

    // APP DEV TUNNEL (on-site dev via hardened sish tunnel — P1 control plane).
    // ALL optional so envs without the feature still boot; the feature is dark
    // behind the `app-blocks-dev-tunnel` Flipt flag regardless.
    //
    // APPS_DEV_TUNNEL_SISH_SECRET   shared secret the sish server presents on the
    //   authz callback so random internet cannot POST it. Carried as the trailing
    //   PATH segment of the callback URL
    //   (`POST /api/apps/dev-tunnel/authz/<secret>`) because sish v2.23.0's
    //   `authentication-key-request-url` does a bare POST and CANNOT attach a
    //   custom header (F5). MUST be a URL-PATH-SAFE token (no `/`, no whitespace,
    //   no reserved chars) — generate as hex/base64url. When UNSET the callback
    //   fail-closes (503) — the sish integration is inert until provisioned (P3).
    APPS_DEV_TUNNEL_SISH_SECRET: z.string().optional(),
    // APPS_DEV_TUNNEL_FORWARDAUTH_URL   in-cluster address of the dev-tunnel-gate
    //   forwardAuth endpoint the ephemeral Middleware points Traefik at. When
    //   unset, derived from the civitai-web Service default.
    APPS_DEV_TUNNEL_FORWARDAUTH_URL: z.string().url().optional(),
    // APPS_DEV_TUNNEL_SISH_BACKEND   the sish HTTP backend the reverse tunnel is
    //   bound behind, as `service.namespace:port` (or a full URL). Default is the
    //   P0 sish Service.
    APPS_DEV_TUNNEL_SISH_BACKEND: z
      .string()
      .default('http://sish-http.apps-dev-tunnel.svc.cluster.local:8080'),
    // APPS_DEV_TUNNEL_INGRESS_TARGET   the Traefik LB IP the ephemeral
    //   `dev-<hex>.<APPS_DOMAIN>` DNS record points at. Set PER-ENVIRONMENT (e.g. the
    //   dp-prod SOPS env) — intentionally NO default so the origin IP is not committed
    //   to the repo. When set, the dev-tunnel IngressRoute carries external-dns
    //   annotations and the host resolves (CF-proxied); when unset, no record is
    //   created (the tunnel host is NXDOMAIN). external-dns runs source=traefik-proxy,
    //   domain civit.ai.
    APPS_DEV_TUNNEL_INGRESS_TARGET: z.string().optional(),
    // APPS_DEV_TUNNEL_ROUTE_NAMESPACE   the namespace the ephemeral dev-tunnel
    //   IngressRoute + forwardAuth Middleware are created in. MUST match the sish
    //   backend's namespace (apps-dev-tunnel) — Traefik rejects a cross-namespace
    //   service reference. The apply Job still runs in APPS_KUBE_NAMESPACE.
    APPS_DEV_TUNNEL_ROUTE_NAMESPACE: z.string().default('apps-dev-tunnel'),
    // APPS_DEV_TUNNEL_SSH_HOST_PUBKEY   the sish server's SSH HOST public key, as a
    //   NON-SECRET OpenSSH line (`ssh-ed25519 AAAA...`). Returned by
    //   startDevTunnel so the CLI can PIN it on the `ssh -R` hop (R1 — closes the
    //   MITM window; see design Revision-2 gate #6). Unset → startDevTunnel returns
    //   an empty string and the CLI must fail closed (refuse to connect without a
    //   pin) rather than fall back to InsecureIgnoreHostKey.
    APPS_DEV_TUNNEL_SSH_HOST_PUBKEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Sentinel-mode for the system Redis client requires an explicit master group
    // name. The live HA cluster uses `sysmaster`; the node-redis default
    // (`mymaster`) silently produces a Sentinel that never resolves a master, so
    // we refuse to start with REDIS_SYS_SENTINELS set but REDIS_SYS_SENTINEL_NAME
    // missing. The non-sentinel path (REDIS_SYS_URL only) is unaffected.
    if (env.REDIS_SYS_SENTINELS && !env.REDIS_SYS_SENTINEL_NAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_SYS_SENTINEL_NAME'],
        message:
          'REDIS_SYS_SENTINEL_NAME is required when REDIS_SYS_SENTINELS is set (cluster uses "sysmaster")',
      });
    }
    // Self-heal invariant: the slow-settle threshold MUST stay BELOW the per-command deadline
    // reaper. When the reaper is active at T and a command orphans, the deadline reaps it at ~T, so
    // done() observes ~T; if the slow threshold S >= T, that reaped orphan is NOT recorded (T < S)
    // and the cluster self-heal goes BLIND to the exact deadline-park wedge this trigger exists to
    // catch (2026-07-06). Only enforced when BOTH are active (>0): the reaper can be disabled (T=0)
    // — the settle-time signal still works without it — and slow-settle recording can be off (S=0).
    if (
      env.REDIS_CLUSTER_COMMAND_TIMEOUT_MS > 0 &&
      env.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS > 0 &&
      env.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS >= env.REDIS_CLUSTER_COMMAND_TIMEOUT_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS'],
        message:
          `REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS (${env.REDIS_CLUSTER_SELFHEAL_SLOW_COMMAND_MS}) must be < ` +
          `REDIS_CLUSTER_COMMAND_TIMEOUT_MS (${env.REDIS_CLUSTER_COMMAND_TIMEOUT_MS}): the slow-settle self-heal ` +
          `threshold has to stay below the deadline reaper, else deadline-reaped orphans settle just under the ` +
          `reaper and never record a hit → the cluster self-heal goes blind to the deadline-park wedge.`,
      });
    }
  });
