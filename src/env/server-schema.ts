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
export const serverSchema = z.object({
  DATABASE_IS_PROD: zc.booleanString.default(isProd),
  DATABASE_URL: z.url(),
  DATABASE_REPLICA_URL: z.url(),
  DATABASE_REPLICA_LONG_URL: z.url().optional(),
  DATABASE_SSL: zc.booleanString.default(true),
  NOTIFICATION_DB_URL: z.url(),
  NOTIFICATION_DB_REPLICA_URL: z.url(),
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
  REDIS_SYS_SENTINEL_NAME: z.string().default('mymaster'), // master group name; set to "sysmaster" at deploy time
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
  // Per-command timeout (ms) applied ONLY to verified fail-open hot-path reads
  // (refreshToken pipeline, needsUpdate/getClientConfigCached). node-redis arms an
  // AbortSignal.timeout per command that rejects a parked/slow command with a
  // TimeoutError — at these call sites a TimeoutError is caught and degrades (keep
  // session / skip update banner), so it converts a 30s park into a fast fail-open,
  // never a 500. Default is far above normal latency (<5ms) so it only fires on a
  // genuine stall. Set to 0 to disable the per-command layer (socketTimeout still
  // applies). Tunable for canary rollout.
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().default(2000),
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
  DISCORD_CLIENT_ID: z.string(),
  DISCORD_CLIENT_SECRET: z.string(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_WEBHOOK_MOD_ALERTS: z.string().optional(),
  GITHUB_CLIENT_ID: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  REDDIT_CLIENT_ID: z.string(),
  REDDIT_CLIENT_SECRET: z.string(),
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

  FLIPT_URL: z.string(),
  FLIPT_FETCHER_SECRET: z.string(),
  FLIPT_DEPLOYMENT_ID: z.string().optional(),

  // B2 Upload — model files (gated by Flipt flag B2_UPLOAD_DEFAULT)
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
  APPS_KUBE_NAMESPACE: z.string().default('civitai-apps'),
  APPS_DOMAIN: z.string().default('civit.ai'),

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
});
