import { createFliptClient } from '@civitai/flipt';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

export enum FLIPT_FEATURE_FLAGS {
  // Mirrors the `articleRatingDispute` fliptKey in feature-flags.service.ts so
  // background paths (no request context) can gate on the same Flipt flag the
  // tRPC `isFlagProtected('articleRatingDispute')` endpoints use.
  ARTICLE_RATING_DISPUTE = 'article-rating-dispute',
  FEED_IMAGE_EXISTENCE = 'feed-image-existence',
  FEED_POST_FILTER = 'feed-fetch-filter-in-post',
  REDIS_CLUSTER_ENHANCED_FAILOVER = 'redis-cluster-enhanced-failover',

  GIFT_CARD_VENDOR_WAIFU_WAY = 'gift-card-vendor-waifu-way',
  GIFT_CARD_VENDOR_LEWT_DROP = 'gift-card-vendor-lewt-drop',
  GIFT_CARD_VENDOR_CRYPTO = 'gift-card-vendor-crypto',
  IMAGE_TRAINING = 'image-training',
  VIDEO_TRAINING = 'video-training',
  AI_TOOLKIT_SD15 = 'ai-toolkit-sd15',
  AI_TOOLKIT_SDXL = 'ai-toolkit-sdxl',
  AI_TOOLKIT_FLUX = 'ai-toolkit-flux',
  AI_TOOLKIT_SD35 = 'ai-toolkit-sd35',
  AI_TOOLKIT_HUNYUAN = 'ai-toolkit-hunyuan',
  AI_TOOLKIT_WAN = 'ai-toolkit-wan',
  AI_TOOLKIT_CHROMA = 'ai-toolkit-chroma',
  QWEN_TRAINING = 'qwen-training',
  FLUX2_TRAINING = 'flux2-training',
  ZIMAGE_TURBO_TRAINING = 'zimage-turbo-training',
  ZIMAGE_BASE_TRAINING = 'zimage-base-training',
  FLUX2_KLEIN_TRAINING = 'flux2-klein-training',
  LTX2_TRAINING = 'ltx2-training',
  LTX23_TRAINING = 'ltx23-training',
  LTX25_TRAINING = 'ltx25-training',
  WAN22_TRAINING = 'wan22-training',
  IMAGE_TRAINING_RESULTS = 'image-training-results',
  CHALLENGE_PLATFORM_ENABLED = 'challenge-platform-enabled',
  // Gates every non-legacy judging engine. Default-off, so a challenge whose `judgingEngine`
  // column points at the pairwise ladder still runs the legacy absolute path until this is on.
  CHALLENGE_PAIRWISE_JUDGING = 'challenge-pairwise-judging',
  COMIC_CREATOR = 'comic-creator',
  GENERATION_PRESETS = 'generation-presets',
  GENERATION_TESTING = 'generation-testing',
  GENERATION_EXPERIMENTAL = 'generation-experimental',
  AI_TOOLKIT_DEFAULT_SD = 'ai-toolkit-default-sd',
  WAN22_MULTI_STEP = 'wan22-multi-step',
  ENHANCED_COMPATIBILITY_SDCPP = 'enhanced-compatibility-sdcpp',
  IMAGE_INDEX_FEED = 'image-index-feed',
  // Routes ImageResourceNew reads to the writer (primary) instead of the read
  // replica while the DataPacket replica is missing historical backfill rows
  // for imageId < ~110M. Flip off once backfill is complete.
  IMAGE_RESOURCE_USE_WRITE = 'image-resource-use-write',
  // Global kill-switch: when on, getDbWithoutLag routes every lag-aware read to
  // primary regardless of per-id Redis flags. Use during an elevated rep-lag
  // incident so RAW reads (e.g. reaction toggles) stay consistent without
  // paying the per-flag Redis write/read cost.
  HIGH_REPLICATION_LAG_MODE = 'high-replication-lag-mode',
  LICENSING_FEE = 'licensing-fee',
  WILDCARDS = 'wildcards',
  // Global flag for the anti-hang timeouts on server request-path fetches,
  // DEFAULT-OFF (feature ships dormant; the timeout applies only when this is
  // explicitly ON). Flip ON to activate. See fetchTimeoutSignal.
  HOT_PATH_FETCH_TIMEOUTS = 'hot-path-fetch-timeouts',
  // Kill switch for BOTH unattended paths that flag a model minor by SHA256
  // match: the scan-time hook and the nightly sweep job. DEFAULT-OFF — isFlipt
  // returns false for an unknown flag or an unreachable Flipt, and for a path
  // that auto-restricts other people's models, not flagging is the safe
  // failure. Deliberately does NOT gate /api/admin/temp/minor-hash-sweep, so
  // rollback stays usable after the switch is thrown.
  MINOR_HASH_AUTO_FLAG = 'minor-hash-auto-flag',
  // Gates SUBMISSION of model name+description to XGuard from upsertModel. Keyed on
  // modelId so a percentage rollout picks a deterministic, sticky subset of content.
  // DEFAULT-OFF — isFlipt returns false for an unknown flag or an unreachable Flipt.
  MODEL_TEXT_MODERATION_XGUARD = 'model-text-moderation-xguard',
  // Gates APPLYING the verdict (the `nsfw` write). Separate from the submit flag so the
  // scan can run in shadow — verdicts recorded to EntityModeration and the audit log while
  // the profanity filter stays solely in charge of the column. For a path that
  // auto-restricts other people's models, not flagging is the safe failure.
  MODEL_TEXT_MODERATION_XGUARD_APPLY = 'model-text-moderation-xguard-apply',
  // Arms the reaction reconciliation audit's repair path to WRITE compensating
  // events to ClickHouse. Default-off — isFlipt returns false for an unknown flag
  // or an unreachable Flipt, and for a path that mutates production metrics that
  // is the safe failure. Off, the hourly path does nothing at all and the nightly
  // one runs its diff as a dry run for visibility.
  METRIC_REACTION_REPAIR = 'metric-reaction-repair',
  // Lets the auto-feature job top up the Featured Images collection from the featured
  // collections pool. Default-off, and the job's config carries its own `dryRun` on top,
  // so the homepage cannot change until both are deliberately turned on.
  AUTO_FEATURE_IMAGES = 'auto-feature-images',
  // Arms the placement Buzz reconcile sweep. Default-off, and it must STAY off
  // until the migration's backfill has been re-run against the deployed code —
  // everything approved between the ALTER and that re-run carries no
  // `metricCountedAt` while already having been counted, so a sweep running
  // first re-emits all of it and roughly doubles those counters permanently.
  PLACEMENT_METRIC_SWEEP = 'placement-metric-sweep',
  // Early-adopter cohort gate. Segments on the `isEarlyAdopter` Flipt context property
  // that `buildFliptContext` emits from the user's opt-in setting, so background paths
  // (no request context) can gate on the same flag the request path does.
  //
  // 🔴 NOT default-off in the usual sense. `isFlipt` returns false for an UNKNOWN flag, but
  // once this flag exists its answer for a non-matching entity is the flag's own `enabled`
  // value, which Flipt returns when no rollout matches. So a caller that evaluates this
  // WITHOUT the `isEarlyAdopter` context — which is every background path, since there is
  // no request user to build a context from — gets that default, not false. It is false
  // only because flipt-state pins the flag `enabled: false`. Pass a real context, or treat
  // a bare `isFlipt(EARLY_ADOPTER)` as "is the programme switched on at all", never as
  // "is this user an early adopter".
  EARLY_ADOPTER = 'early-adopter',
  // Gates the blurb editor control and the save-path expansion — NOT the fan-out job, which
  // stays ungated so a creator who leaves the rollout keeps their existing references maintained.
  // DEFAULT-OFF — isFlipt returns false for an unknown flag, and not expanding is
  // the safe failure for a feature that rewrites published content.
  //
  // 🔴 RAMP BY PERCENTAGE OR BOOLEAN ONLY — A SEGMENT ROLLOUT MATCHES NOTHING. The server-side
  // gate (blurb-materialize.service.ts) evaluates this with an entityId and NO context, because
  // the entity is the content OWNER and no SessionUser for the owner is on hand there. Every
  // identity/tier/cohort segment in flipt-state is a STRING_COMPARISON constraint that reads the
  // context, so a segment rule here returns the flag default and looks exactly like "blurbs are
  // off". The site is recorded in ENTITY_WITHOUT_CONTEXT_LEDGER (flipt-eval-context.test.ts).
  TEXT_BLURBS = 'text-blurbs',

  // 🔴 BOOLEAN ONLY — neither a segment NOR a percentage rollout works on this one.
  // `throwOnBlockedUserContent` evaluates it with no context AND no entityId, because several of
  // its call sites are content fan-outs with no session in scope. A segment rollout reads the
  // context and so matches nothing; a threshold rollout buckets on `hash(entityId + flagKey)` and
  // the entityId defaults to the literal `'global'`, so every evaluation in production hashes one
  // constant and the flag is 0% or 100% with nothing in between. Set the boolean, not a ramp.
  //
  // OFF is the shipped default and means the pattern list is recorded but not enforced on these
  // surfaces. The link-domain half throws either way — this flag has never governed it.
  USER_CONTENT_PATTERN_ENFORCE = 'user-content-pattern-enforce',
}

// Flags exempt from caching: incident kill-switches where an operator expects a
// flip to take effect ASAP and the eval is either rare (cold path) or the extra
// staleness is not worth the CPU saved.
// - REDIS_CLUSTER_ENHANCED_FAILOVER: evaluated only from Redis node-error/
//   disconnect handlers (near-zero call volume → no CPU benefit) but gates
//   failover during an incident, so caching it is all downside.
// - HIGH_REPLICATION_LAG_MODE: an operator flips this ON during an active
//   rep-lag incident to force RAW reads to primary; a ~70s (10s TTL + 60s poll)
//   propagation delay prolongs the stale-read window the flag exists to close.
//   It's only evaluated on the no-arg fallback path of getDbWithoutLag (RAW
//   reads without per-id flagging — db-lag-helpers.ts:42,94), not the hot
//   per-id path, so the CPU saved by caching it is modest. Correctness wins.
//
// NOT bypassed (deliberate): IMAGE_RESOURCE_USE_WRITE is also a global
// replica/primary read-routing switch, but its intended flip is OFF-once-
// backfill-complete — non-urgent and in the safe direction. It's evaluated on
// hot image read paths (image.service.ts) with a single global key, so caching
// gives the largest CPU win of any flag here; bypassing would re-add a
// per-request wasm eval on the hot path. If its propagation latency ever
// matters during an incident, lower FLIPT_EVAL_CACHE_TTL_MS globally rather
// than bypassing this one flag.
const FLIPT_EVAL_CACHE_BYPASS = new Set<string>([
  FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER,
  FLIPT_FEATURE_FLAGS.HIGH_REPLICATION_LAG_MODE,
  // Thrown when auto-flagging is misfiring, so propagation should be the 60s
  // config poll alone. Evaluated once per model-file scan and once per nightly
  // job run — nowhere near hot enough for the cache to be worth the extra lag.
  FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG,
  // The stop button for a sweep that can permanently double production counters
  // — nothing takes a counter back down. Evaluated about ten times per
  // five-minute tick, so the cache saves nothing measurable and the staleness is
  // all cost at the moment someone is trying to turn it off.
  FLIPT_FEATURE_FLAGS.PLACEMENT_METRIC_SWEEP,
]);

// 🔴 SHARED_STATE — this module is emitted TWICE in the production server build.
// Measured, not assumed: `[flipt] eval cache TTL:` appears exactly 2x on every pod
// (488 lines across 244 pod streams), against ONE `[instrumentation] Running in
// nodejs runtime`.
//
// Without the globalThis pin below, each emitted copy owned a PRIVATE wasm client,
// a private config poller and a private pair of eval caches. Two consequences, and
// the second is why this is pinned rather than documented:
//
//   1. Duplicated work per pod — two wasm engines and two 60s config polls.
//   2. Any reader that closes over "the" client sees ONE of the two. That is
//      exactly how `civitai_app_heavy_bulkhead_active`/`_rejects` emitted zero
//      series for 74 days while looking registered, deployed and healthy (#4173),
//      and it is why `src/server/utils/request-bulkhead.ts` is enrolled in
//      scripts/server-graph-watchlist.mjs. `getFliptCacheStats` below is precisely
//      such a reader, so an unpinned client would make the eval-cache metrics a
//      confident half-measurement — worse than their absence, because the number
//      they exist to arbitrate (TTL-bound vs capacity-bound) is biased by the
//      split: one key space divided across two caches at the same ceiling rotates
//      far less than one cache holding all of it, which reads as "TTL-bound" and
//      sends you to the knob that changes nothing.
//
// Enrolled as SHARED_STATE on `__civitaiFliptClient` in server-graph-watchlist.mjs,
// so a future refactor that drops this pin fails that gate. Vitest cannot see this
// (it loads each module once).
// `scripts/__tests__/check-server-graph-singletons.test.ts` asserts this EXACT shape
// against comment-stripped source, so an aliased handle
// (`const g = globalThis as …; g.__civitaiFliptClient ??= …`) does NOT satisfy it —
// the gate must be able to recognise the pin inside a bundled chunk. `??=`
// specifically, not `=`: `=` makes the second copy REPLACE the first's client
// instead of adopting it, which is the original bug in one character.
declare global {
  // eslint-disable-next-line no-var
  var __civitaiFliptClient: ReturnType<typeof createFliptClient> | undefined;
}

const flipt = (globalThis.__civitaiFliptClient ??= createFliptClient({
  url: env.FLIPT_URL,
  clientToken: env.FLIPT_FETCHER_SECRET,
  cacheBypass: FLIPT_EVAL_CACHE_BYPASS,
  onInitError: (error) => {
    logToAxiom(
      {
        type: 'init-flipt-error',
        error: error.message,
        cause: error.cause,
        stack: error.stack,
      },
      'temp-search'
    ).catch();
  },
}));

// 🔴 THE ENTITY-ID TRAP. All four evaluators below take `(flag, entityId?,
// context?)`, and the two arguments are NOT interchangeable. A Flipt segment
// constraint reads one of two inputs depending on its TYPE:
// `ENTITY_ID_COMPARISON_TYPE` matches the `entityId` argument, while
// `STRING_COMPARISON_TYPE` matches a named property of the `context`. Of the 15
// segments in flipt-state today, 12 are the latter — including every identity,
// tier and cohort segment we have (`moderators`, `testers`, `early-adopters`,
// `members`, `app-dev-testers`, `CreatorProgram`, …).
//
// So `isFlipt(FLAG, String(user.id))` cannot match any of those, for anybody.
// It returns the flag's base `enabled` value instead, which is indistinguishable
// from an honest "this user is not in the segment" — no error, no log line. Pass
// `buildFliptContext(user)`, or at minimum the properties you actually know.
// Enforced by `src/server/flipt/__tests__/flipt-eval-context.test.ts`.
export const isFlipt = flipt.isEnabled;
export const getFliptVariant = flipt.getVariant;
export const getFliptBoolean = flipt.getBoolean;
export const isFliptSync = flipt.isEnabledSync;
export const ensureFliptInitialized = flipt.ensureInitialized;
// Eval-cache counters for ~/server/metrics/flipt-eval-cache.metrics. Closes over the
// caches (no `this`), so unbinding here is safe — same as the accessors above.
export const getFliptCacheStats = flipt.getCacheStats;

// Build the inner `(entityId, metricType, day, total)` subquery the direct CH
// read sites (search-index / comic populate / metric-helpers) sum over. `where`
// is the caller's full WHERE clause (e.g. "WHERE entityType = 'Image' AND ...").
// Reads the already-FINAL view `entityMetricDailyAgg_v2`, so we select total
// directly (no argMax dedup). Selecting metricType is harmless even for callers
// that only group by day (it's just carried through the subquery).
//
// This MUST stay on the same table as the other entity-metric reader,
// `MetricService` (the watcher-fed `metrics:*` cache populate), which hardcodes
// `entityMetricDailyAgg_v2` in event-engine-common.
//
// Why that matters: the legacy ReplacingMergeTree `entityMetricDailyAgg_new`
// was DROPPED from ClickHouse on 2026-06-24. A reader still pointed at it threw
// `UNKNOWN_TABLE` (~100k/hr) → 500s on /api/v1/images and on-site image feeds.
// v2 is permanent — never repoint either reader at `_new`.
export function buildEntityMetricPerDaySource(where: string): string {
  return `(
      SELECT entityId, metricType, day, total
      FROM entityMetricDailyAgg_v2
      ${where}
    )`;
}
