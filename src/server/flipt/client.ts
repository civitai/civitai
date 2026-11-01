import { createFliptClient } from '@civitai/flipt';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

export enum FLIPT_FEATURE_FLAGS {
  // Mirrors the `articleRatingDispute` fliptKey in feature-flags.service.ts so
  // background paths (no request context) can gate on the same Flipt flag the
  // tRPC `isFlagProtected('articleRatingDispute')` endpoints use.
  ARTICLE_RATING_DISPUTE = 'article-rating-dispute',
  // Mirrors `ratingDispute`, for the scan-completion auto-approve of every other entity.
  RATING_DISPUTE = 'rating-dispute',
  FEED_IMAGE_EXISTENCE = 'feed-image-existence',
  FEED_POST_FILTER = 'feed-fetch-filter-in-post',
  // Serves the image feed from the PostgreSQL feed service (page from the feed, rows from
  // Postgres) for matching users; everyone else keeps Meilisearch with the feed in shadow.
  FEED_SERVICE_PRIMARY = 'feed-service-primary',
  // The same for the public REST images endpoint, apart so either can be rolled back alone.
  FEED_SERVICE_REST_IMAGES = 'feed-service-rest-images',
  // Under FEED_SERVICE_PRIMARY, also serves hub feeds from the feed service. Off or
  // missing, a hub stays on Meilisearch while every other shape follows the flag above.
  FEED_SERVICE_HUBS = 'feed-service-hubs',
  // The image feed without Meilisearch: every website and REST image-feed request goes to the feed
  // service, whatever the three flags above say, and what the feed cannot serve is answered without
  // the search index (an empty page, a retryable 503, or a 400 for a sort it does not have) instead
  // of falling back. Off or missing, the flags above decide as before.
  FEED_SERVICE_MEILI_OFF = 'feed-service-meili-off',
  REDIS_CLUSTER_ENHANCED_FAILOVER = 'redis-cluster-enhanced-failover',
  // Reads the viewer's image reactions (`getUserReactionsForImages`) through Kysely-over-pg instead
  // of the Prisma query engine — an A/B of the engine's per-query CPU on one high-volume read.
  // DEFAULT-OFF: `isFlipt` returns false for an unknown flag or an unreachable Flipt, which keeps
  // the Prisma path. Both paths read the same replica and return the same rows.
  //
  // 🔴 BOOLEAN ONLY. Evaluated once per call with no entityId and no context (a single cached key,
  // so the gate adds no per-user cache churn on a hot path); a percentage rollout hashes the literal
  // 'global' and is 0% or 100%, and a segment rule matches nothing.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false is fine) BEFORE THIS CODE SERVES TRAFFIC,
  // and must not be deleted while it does. A MISSING key makes `evaluateBoolean` throw; the throw
  // bypasses the eval cache and the default `onEvalError` console.errors — on every call of a
  // read issued on every signed-in image feed page. It still answers false (Prisma), but the log
  // flood and the uncached wasm eval also inflate the "off" baseline this flag exists to measure.
  //
  // 🔴 ON MOVES THE READ OFF PRISMA'S POOL ONTO THE SHARED `pgDbRead` POOL (kyselyRead is built
  // over it, src/server/db/kyselyDb.ts). Two properties of the ON state to check before flipping:
  //  - That pool's acquire wait is `DATABASE_CONNECTION_TIMEOUT`, whose default is 0 = WAIT FOREVER
  //    (packages/civitai-db/src/env.ts). Prisma's pool times out instead. So the environment must
  //    set a non-zero DATABASE_CONNECTION_TIMEOUT, or a saturated pool hangs these requests.
  //  - Failures surface as pg errors, not Prisma P2024/P1008, so `prismaErrorToTrpcCode` no longer
  //    maps a pool timeout to TIMEOUT.
  // The ON window therefore also changes `pgDbRead` contention, not only query-engine CPU.
  KYSELY_IMAGE_REACTIONS = 'kysely-image-reactions',
  // Reads the placement/sticker read family (packages/civitai-db-queries/src/placement.db.ts)
  // through Kysely-over-pg instead of the Prisma query engine: the space resolution behind every
  // placement surface, the price range, getCapTier, the free-placement display counts, the pending
  // badge counts and the sticker listing/counts. DEFAULT-OFF, same semantics as
  // KYSELY_IMAGE_REACTIONS above: boolean only, evaluated with no entityId.
  //
  // 🔴 Each read keeps its database: a `dbWrite` read (the target/owner lookup, the space rows and
  // getCapTier, which decide whether a placement is allowed and what it costs) moves to
  // `kyselyWrite` over the shared `pgDbWrite` pool; a `dbRead` read moves to `kyselyRead` over
  // `pgDbRead`. The counts inside the free-placement claim transaction never switch — they decide
  // under advisory locks on the Prisma `tx`.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // this is evaluated on every image detail view's space resolution and every session's badge
  // counts.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` AND `pgDbWrite`. Their acquire wait is
  // `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER (packages/civitai-db/src/env.ts), where
  // Prisma's pool times out, so the environment must set a non-zero value before flipping. Failures
  // surface as pg errors, not Prisma P2024/P1008, so `prismaErrorToTrpcCode` no longer maps a pool
  // timeout to TIMEOUT. The ON window also changes contention on both pg pools, the writer's
  // included, not only query-engine CPU.
  KYSELY_PLACEMENT_READS = 'kysely-placement-reads',
  // Reads two hot nested Prisma reads (packages/civitai-db-queries/src/hot-reads.db.ts) through
  // Kysely-over-pg instead of the Prisma query engine, which fans each out into one query per
  // relation: the model page's `modelWithDetailsSelect` read (`getModel`) and the creator card
  // (`fetchUserCreator`); plus the image tags behind `imageTagsCache` and an image's comment-thread
  // lookup (commentsv2.service). DEFAULT-OFF, same semantics as KYSELY_IMAGE_REACTIONS above:
  // boolean only, evaluated with no entityId.
  //
  // 🔴 Each read keeps its database: the model read takes `getKyselyWithoutLag('model', id)`, the
  // same lag decision `getDbWithoutLag('model', id)` made for Prisma; the image tags read the
  // primary on a write-triggered refresh and the replica otherwise, as before; the creator card and
  // the thread lookup read `kyselyRead`, as they read `dbRead`.
  // Each read runs its statements one after another on ONE pooled connection (the model page up to
  // four, the creator card two), and every VIEW ("UserStat", "ModelReportStat", "GenerationCoverage",
  // "ImageTag") is filtered by its key as a parameter, never reached through a join.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // this is evaluated on every model page and every creator-card cache miss.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` (and `pgDbWrite` for a lag-flagged
  // model). Their acquire wait is `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER
  // (packages/civitai-db/src/env.ts), so the environment must set a non-zero value before flipping.
  // Failures surface as pg errors, not Prisma P2024/P1008.
  KYSELY_HOT_READS_2 = 'kysely-hot-reads-2',
  // Reads the next hot Prisma read shapes (packages/civitai-db-queries/src/hot-reads-3.db.ts) through
  // Kysely-over-pg instead of the Prisma query engine: the model page's default-version lookup
  // (`getDefaultModelVersion`, three Prisma queries, one statement here), three reads
  // `getModelHandler` makes after the model row (the suggested-resource count, the owner's settings,
  // the owner's posts on the versions), and the viewer's pending remix-gallery submissions
  // (`getViewerPendingSubmissions`). DEFAULT-OFF, same semantics as KYSELY_HOT_READS_2 above: boolean
  // only, evaluated with no entityId. Every statement reads base tables only, never a view.
  //
  // 🔴 Each read keeps its database: the default-version lookup takes
  // `getKyselyWithoutLag('model', id)`, the twin of the `getDbWithoutLag('model', id)` decision the
  // Prisma read made; the others read `kyselyRead`, as they read `dbRead`.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // this is evaluated on every model page render and every model page payload.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` (and `pgDbWrite` for a lag-flagged
  // model). Their acquire wait is `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER
  // (packages/civitai-db/src/env.ts), so the environment must set a non-zero value before flipping.
  // Failures surface as pg errors, not Prisma P2024/P1008.
  KYSELY_HOT_READS_3 = 'kysely-hot-reads-3',
  // Reads the model page's comment reads (packages/civitai-db-queries/src/hot-reads-4.db.ts) through
  // Kysely-over-pg instead of the Prisma query engine: the visible top-level comment count
  // (`getVisibleCommentCount`, `comment.getVisibleCountByModel`), both views' counts in one
  // statement (`getVisibleCommentCounts`, `comment.getVisibleCountsByModel`) and the first page of
  // `comment.getAll` (the unpinned list sorted newest or oldest first, and the pinned block), each
  // list with its author, reactions and model name in one statement where Prisma issues one query
  // per relation. A cursor page or another sort stays on Prisma. DEFAULT-OFF, same semantics as
  // KYSELY_HOT_READS_2 above: boolean only, evaluated with no entityId. Every statement reads base
  // tables only, never a view.
  //
  // 🔴 Each read keeps its database: `getKyselyWithoutLag('commentModel', modelId)`, the twin of the
  // `getDbWithoutLag('commentModel', modelId)` decision the Prisma reads make.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // this is evaluated on every model page comment count and comment list request.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` (and `pgDbWrite` for a lag-flagged
  // model). Their acquire wait is `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER
  // (packages/civitai-db/src/env.ts), so the environment must set a non-zero value before flipping.
  // Failures surface as pg errors, not Prisma P2024/P1008.
  KYSELY_HOT_READS_4 = 'kysely-hot-reads-4',
  // The reads in packages/civitai-db-queries/src/hot-reads-5.db.ts, through Kysely instead of Prisma.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // several of these reads run on most page views.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` (and `pgDbWrite` for a lag-flagged
  // entity). Their acquire wait is `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER
  // (packages/civitai-db/src/env.ts), so the environment must set a non-zero value before flipping.
  // Failures surface as pg errors, not Prisma P2024/P1008.
  KYSELY_HOT_READS_5 = 'kysely-hot-reads-5',
  // The reads in packages/civitai-db-queries/src/hot-reads-6.db.ts, through Kysely instead of Prisma.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC. A missing
  // key makes `evaluateBoolean` throw, bypass the eval cache and console.error on every call — and
  // several of these reads run on most page views.
  //
  // 🔴 ON MOVES THESE READS OFF PRISMA'S POOLS ONTO `pgDbRead` (and `pgDbWrite` for a lag-flagged
  // entity). Their acquire wait is `DATABASE_CONNECTION_TIMEOUT`, default 0 = WAIT FOREVER
  // (packages/civitai-db/src/env.ts), so the environment must set a non-zero value before flipping.
  // Failures surface as pg errors, not Prisma P2024/P1008.
  KYSELY_HOT_READS_6 = 'kysely-hot-reads-6',
  // ON skips `getImagesForModelVersionCache`'s per-entry tag lookup, which is keyed by model
  // version ids as if they were image ids (so a hit attaches an unrelated image's tags) and whose
  // result no consumer reads. Evaluated without a user id on every call.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC — a missing
  // key makes `evaluateBoolean` throw and log on every call.
  MODEL_VERSION_IMAGES_SKIP_TAGS = 'model-version-images-skip-tags',
  // ON skips `getModelHandler`'s read of the owner's posts on the versions (`modelVersions[].posts`)
  // when the viewer is neither the owner nor a moderator, returning `posts: []` on every version —
  // what an owner with no posts gets. Every client reader of that field is owner- or
  // moderator-only (the publish/republish buttons, the version list's problem icons and menu, the
  // model wizard). Owners and moderators are unchanged. Boolean, evaluated with no entityId, and
  // only for a viewer who is neither.
  //
  // 🔴 THE KEY MUST EXIST IN FLAG STATE (enabled: false) BEFORE THIS CODE SERVES TRAFFIC — a missing
  // key makes `evaluateBoolean` throw and log on every call.
  MODEL_GETBYID_SKIP_OWNER_POSTS = 'model-getbyid-skip-owner-posts',

  GIFT_CARD_VENDOR_WAIFU_WAY = 'gift-card-vendor-waifu-way',
  GIFT_CARD_VENDOR_LEWT_DROP = 'gift-card-vendor-lewt-drop',
  GIFT_CARD_VENDOR_CRYPTO = 'gift-card-vendor-crypto',
  // The stop button for `delete-old-training-data`'s S3 deletes. Default-OFF by
  // construction: isFlipt returns false for an unknown flag or an unreachable Flipt,
  // so the purge stays dormant until someone turns it on deliberately.
  TRAINING_DATA_PURGE = 'training-data-purge',
  // Resolve every row and log what WOULD be deleted, without deleting it. Also default-off, which
  // means it cannot make the purge safer on its own — the operator procedure is to turn this ON
  // FIRST, then the purge, read a night's output, and only then turn this off. Written down on
  // DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS because a two-flag order that nobody records is a
  // trap rather than a safeguard.
  TRAINING_DATA_PURGE_DRY_RUN = 'training-data-purge-dry-run',
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
  // Streams the two large evidence archives straight to object storage instead of staging them
  // on the container's local scratch volume first. DEFAULT-OFF — `isFlipt` returns false for an
  // unknown flag or an unreachable Flipt, which leaves the long-standing disk-staging path in
  // charge. Evaluated ONCE per report, never per archive, so a mid-report flip cannot produce a
  // bundle assembled two different ways. Flip OFF to roll back without a deploy; the disk path
  // is kept intact and reachable for exactly that reason.
  CSAM_ARCHIVE_STREAM_UPLOAD = 'csam-archive-stream-upload',
  COMIC_CREATOR = 'comic-creator',
  GENERATION_PRESETS = 'generation-presets',
  GENERATION_TESTING = 'generation-testing',
  GENERATION_EXPERIMENTAL = 'generation-experimental',
  AI_TOOLKIT_DEFAULT_SD = 'ai-toolkit-default-sd',
  ENHANCED_COMPATIBILITY_SDCPP = 'enhanced-compatibility-sdcpp',
  IMAGE_INDEX_FEED = 'image-index-feed',
  // Takedown CDN sync: the `cdn-access-sync` and `cdn-access-reconcile` jobs. Ships dark.
  CDN_ACCESS_SYNC = 'cdn-access-sync',
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
  // Writes superjson tRPC responses with `fastSuperjsonSerialize` (same output, cheaper walk)
  // instead of `superjson.serialize`. DEFAULT-OFF: `isFliptSync` returns null for an unknown flag
  // or an uninitialized client, which keeps `superjson.serialize`. Global boolean, evaluated with
  // no entity or context. See `responseWriteSerialize`.
  TRPC_FAST_SUPERJSON_WRITE = 'trpc-fast-superjson-write',
  // Hands a full page load's server render the prefetched state it serialised into `trpcState`
  // instead of letting `withTRPC` parse it again (see `createServerSideProps`). DEFAULT-OFF:
  // `isFliptSync` returns null for an unknown flag or an uninitialized client, which keeps the
  // parse. Evaluated per request (user id, or one of a fixed set of anonymous buckets) so a
  // percentage rollout splits traffic.
  SSR_SKIP_TRPCSTATE_REPARSE = 'ssr-skip-trpcstate-reparse',
  // Lets `withSpan` (@civitai/telemetry/otel-helpers) run its work without opening a span when the
  // active parent is a local, unsampled span — that span could never be recorded or exported.
  // DEFAULT-OFF: `isFliptSync` returns null for an unknown flag or an uninitialized client, which
  // keeps today's behaviour. Global boolean, evaluated with no entity or context, and read at most
  // once per refresh interval per process. See `src/server/utils/otel-withspan-gate.ts`.
  //
  // Add the key (enabled: false) to flag state before flipping it. A missing key just reads as off:
  // `evaluateBoolean` throws and `isFliptSync` swallows it, at most once per refresh per process.
  OTEL_WITHSPAN_SKIP_UNSAMPLED = 'otel-withspan-skip-unsampled',
  // Picks how `getFeatureFlagsLazy` (feature-flags.service.ts) builds the per-request flag
  // object: ON = one small instance of a class whose prototype carries the per-key getters,
  // defined once at module load; OFF = a fresh object with one getter defined per flag key on
  // every call, as before. Same value per key either way. DEFAULT-OFF: `isFliptSync` returns null
  // for an unknown flag or an uninitialized client, which keeps the old object. Global boolean,
  // evaluated with no entity or context, at most once per 5s per process.
  //
  // Add the key (enabled: false) to flag state before this code serves traffic. A missing key
  // reads as off: `evaluateBoolean` throws (skipping the eval cache) and `isFliptSync` swallows it,
  // at most once per 5s per process.
  FEATURE_FLAGS_LAZY_PROTO = 'feature-flags-lazy-proto',
  // Kill switch for BOTH unattended paths that flag a model minor by SHA256
  // match: the scan-time hook and the nightly sweep job. DEFAULT-OFF — isFlipt
  // returns false for an unknown flag or an unreachable Flipt, and for a path
  // that auto-restricts other people's models, not flagging is the safe
  // failure. Deliberately does NOT gate /api/admin/temp/minor-hash-sweep, so
  // rollback stays usable after the switch is thrown.
  MINOR_HASH_AUTO_FLAG = 'minor-hash-auto-flag',
  // The real-person counterpart of MINOR_HASH_AUTO_FLAG: the scan hook and the nightly sweep that
  // flag or queue a model whose weights match a real-person model. DEFAULT-OFF, and separate so
  // either can be thrown without the other.
  POI_HASH_AUTO_FLAG = 'poi-hash-auto-flag',
  // Kill switch for unpublishing (at scan) and refusing to publish a model whose primary file is a
  // byte-identical copy of another creator's published one. DEFAULT-OFF: while off, matches are only
  // logged to Axiom (name 'duplicate-model-hash', message 'would-block') so the volume can be sized.
  DUPLICATE_MODEL_HASH_BLOCK = 'duplicate-model-hash-block',
  // Turns on the bounty entry file check: the job that hashes model-bounty entry files, and the
  // award and download gates that read its result. DEFAULT-OFF; all three ship dark together,
  // since the award gate refuses files the job has not hashed yet.
  BOUNTY_ENTRY_FILE_CHECK = 'bounty-entry-file-check',
  // Gates SUBMISSION of model name+description to XGuard from upsertModel. Keyed on
  // modelId so a percentage rollout picks a deterministic, sticky subset of content.
  // DEFAULT-OFF — isFlipt returns false for an unknown flag or an unreachable Flipt.
  MODEL_TEXT_MODERATION_XGUARD = 'model-text-moderation-xguard',
  // Gates APPLYING the verdict (the `nsfw` write). Separate from the submit flag so the
  // scan can run in shadow — verdicts recorded to EntityModeration and the audit log while
  // the profanity filter stays solely in charge of the column. For a path that
  // auto-restricts other people's models, not flagging is the safe failure.
  MODEL_TEXT_MODERATION_XGUARD_APPLY = 'model-text-moderation-xguard-apply',
  // LOCAL moderation of App Blocks shared-storage `data` leaves and counter keys — the legacy
  // shared-storage surface and the document store's shared writes alike — in SHADOW: scan after
  // the write commits and record what would have been blocked, without rejecting anything.
  // Same submit/apply split as the XGuard pair above. DEFAULT-OFF.
  //
  // 🔴 EVALUATED PER APP — entityId = the app block id, NO context — so ramp by boolean, by
  // percentage (a sticky subset of apps), or by an ENTITY_ID segment listing app block ids. A
  // context-reading segment (moderators, testers, any cohort) matches nothing here and returns the
  // base value. See `shared-data-moderation.ts`.
  APP_BLOCKS_SHARED_DATA_MODERATION = 'app-blocks-shared-data-moderation',
  // ENFORCE: reject a hit inline (legacy surface: with the title/body belt's consequences; document
  // store: the refusal and the block alert, no Report). Implies the scan — with
  // this on, the shadow flag no longer changes anything. Same evaluation as above. DEFAULT-OFF.
  APP_BLOCKS_SHARED_DATA_MODERATION_ENFORCE = 'app-blocks-shared-data-moderation-enforce',
  // Text scan's kill switch. Off (or Flipt unreachable) puts every entity type back on XGuard,
  // Clavata and the profanity filter, whatever the per-entity rollout in sysRedis says.
  TEXT_SCAN = 'text-scan',
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
  // off". Nothing checks that automatically.
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

  // Kill switch for the event points engine (src/server/events/points). DEFAULT-OFF: an unknown
  // flag, or a client that never initialised, stops every award, removal, hat sync, signals tick
  // and referee run. Evaluated with no context and one fixed entity, so set the boolean and add no
  // rules: a ramp is all or nothing, and a rule can override the boolean.
  EVENT_POINTS_ENGINE = 'event-points-engine',

  // Submits image ingestion as one imageScanning step instead of wdTagging + mediaRating.
  // DEFAULT-OFF — an unknown flag or unreachable Flipt keeps the two-step path. Evaluated
  // with the imageId and no context, so ramp by percentage or boolean; a segment matches nothing.
  IMAGE_INGESTION_IMAGE_SCANNING = 'image-ingestion-image-scanning',

  // Submits a separate shadow audio-scan workflow for each ingested video. DEFAULT-OFF: leave it off
  // until the ImageAudioScan migration is applied and the orchestrator owners OK the worker load.
  // Evaluated with the imageId, so ramp by percentage or boolean. Never changes the visual verdict.
  VIDEO_AUDIO_SCAN = 'video-audio-scan',

  // Records image-scan flags in the moderator label queue. DEFAULT-OFF: leave it off until the queue's
  // tables exist. Labels only; it never changes an image's visibility. Evaluated with the imageId.
  SCAN_LABEL_QUEUE_WRITER = 'scan-label-queue-writer',

  // Runs sync-generator-loaded-resources. DEFAULT-OFF: while off, ModelVersion.generatorLoaded
  // freezes at its last value — once a UI reads it, clear it if this stays off. Boolean only.
  SYNC_GENERATOR_LOADED_RESOURCES = 'sync-generator-loaded-resources',

  // Runs build-resource-intent-cooc (the weekly co-occurrence index build). DEFAULT-OFF. Turn it on
  // only after the ResourceIntentCoocSnapshot migration is applied in that environment, or every
  // run fails at the insert. Boolean only.
  RESOURCE_INTENT_COOC_BUILD = 'resource-intent-cooc-build',

  // Whether a co-occurrence build (the weekly job AND scripts/build-resource-intent-cooc.ts)
  // writes checkpoint mode's attachment section into the snapshot payload. DEFAULT-OFF: off, an
  // unknown flag or an unreachable Flipt writes the 11-element payload older decoders read.
  // 🔴 Turn it on only after the release carrying the section reader has fully rolled out AND its
  // rollback window has passed: a decoder from before that release refuses a payload carrying
  // the section, so a rolled-back pod would find the production snapshot unservable.
  // Boolean only.
  RESOURCE_INTENT_COOC_CHECKPOINT_SECTION = 'resource-intent-cooc-checkpoint-section',

  // Runs build-resource-intent-tag-index (the weekly v1 content-tag index build). DEFAULT-OFF. Turn
  // it on only after the ResourceIntentVocabulary and ResourceIntentTagIndexSnapshot migrations, and
  // 20261106120000_resource_intent_tag_index_snapshot_payload_cap (without it every production build
  // refuses before reading anything), are applied in that environment, a vocabulary is frozen, and the
  // build's env and grants are in place (docs/resource-intent-primitive.md, "v1 content tags").
  // Boolean only.
  RESOURCE_INTENT_TAG_INDEX_BUILD = 'resource-intent-tag-index-build',

  // Lets a pod hold the v1 tag index in memory (resource-intent-tags/holder.ts). DEFAULT-OFF: off,
  // an unknown flag or an unreachable Flipt holds nothing, reads no snapshot, and drops one already
  // held. On, each pod whose request path asks for the index downloads and keeps the newest ready
  // snapshot (about 780 MiB per pod decoded at full coverage, October 2026, and about twice that
  // while reloading; docs/resource-intent-primitive.md, "Holder"), so turn it
  // on only once a ready snapshot exists and the pods that will serve it have
  // RESOURCE_INTENT_TAG_INDEX_BUCKET, its RESOURCE_INTENT_TAG_INDEX_B2_* credentials and the memory.
  // Boolean only.
  RESOURCE_INTENT_TAG_INDEX_HOLDER = 'resource-intent-tag-index-holder',

  // Which of GenerationCoverage's two columns answers "can this generate": ON = `coveredNext`
  // (community checkpoints, downloaded on demand); OFF = `covered` (the weekly auction's list only).
  //
  // 🔴 BOOLEAN ONLY, and global. The orchestrator reads /api/v1/model-versions/mini/[id] with no
  // user to decide what it may load, and the coverage answer is cached and indexed for everyone —
  // so a percentage or segment rollout would have the orchestrator, the cache and the viewer
  // disagreeing about the same model.
  //
  // DEFAULT-OFF is the safe failure: an unreachable Flipt narrows generation to what the cluster
  // already holds rather than opening on-demand loading nobody is watching.
  GENERATION_COVERAGE_NEXT = 'generation-coverage-next',

  // Who may START a download by generating with a checkpoint only the EXPANSION covers. Named for
  // the OPEN state: `isFlipt` answers false for an unknown flag or an unreachable Flipt, so the
  // default and the failure both land on the narrower audience. Evaluate with the user id as
  // entity, or a percentage hashes the literal 'global' and answers the same for everyone. Read it
  // through `coverageAudience`, which is where it meets the tier.
  // docs/features/paid-model-loading-members-gate.md
  GENERATION_LOADING_OPEN_TO_ALL = 'generation-loading-open-to-all',
  // On: generateFromGraph / whatIfFromGraph refuse input urls on external hosts. Off (and unknown
  // or unreachable): they are allowed and counted in generation_input_url_refusals_total{mode="log"}.
  GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS = 'generation-input-refuse-external-hosts',
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
// ⚠ DELIBERATELY NOT HERE: TRAINING_DATA_PURGE. It is a stop button for irreversible deletes, so
// it looks like it belongs — a draft of it was added on exactly that reasoning and then removed.
// The entry would be INERT: that flag is evaluated exactly once per NIGHTLY run against a
// ten-second TTL, so a cached entry has always expired before the next evaluation and bypassing
// can never change what that job sees.
//
// 🔴 NO GENERAL CRITERION IS STATED HERE, AND THAT IS DELIBERATE — THREE DRAFTS OF ONE HAVE NOW
// BEEN WRONG. The first said the entries below are each "evaluated far more often than the TTL";
// at least three of them say otherwise in their own comments. The second offered "caching buys
// nothing AND staleness costs something", which is satisfied by the purge flag it was written to
// exclude — that flag is the clearest case of caching buying nothing. Each attempt was a rule
// invented to justify a membership list that was decided case by case.
//
// So: the list is case by case, and the only thing recorded here is the one case that was
// examined and rejected. TRAINING_DATA_PURGE is read exactly ONCE per nightly run, so a cached
// entry has always expired before the next read and bypassing cannot change what that job sees —
// inert, whatever the rule would have been. If the job is ever changed to re-read it inside its
// loop, that fact stops holding and the question is open again. Do not derive a fourth rule from
// this paragraph; read the entries' own comments.
const FLIPT_EVAL_CACHE_BYPASS = new Set<string>([
  FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER,
  FLIPT_FEATURE_FLAGS.HIGH_REPLICATION_LAG_MODE,
  // Thrown when auto-flagging is misfiring, so propagation should be the 60s
  // config poll alone. Evaluated once per model-file scan and once per nightly
  // job run — nowhere near hot enough for the cache to be worth the extra lag.
  FLIPT_FEATURE_FLAGS.MINOR_HASH_AUTO_FLAG,
  FLIPT_FEATURE_FLAGS.POI_HASH_AUTO_FLAG,
  // Same shape: thrown when the duplicate-hash unpublish misfires, read once per model-file scan.
  FLIPT_FEATURE_FLAGS.DUPLICATE_MODEL_HASH_BLOCK,
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
// `buildFliptContext`’s output is pinned by `flipt-eval-context.test.ts`, against a HAND-COPIED
// model of the segment constraints — nothing reads flipt-state, so a segment changing shape
// upstream is caught by review only. No call site is SCANNED — though a few high-cost sites
// have their own seam tests asserting the evaluation arguments by name: `resolveTestingAccess`,
// the feedback gate, and the app-blocks store pair.
export const isFlipt = flipt.isEnabled;
export const getFliptVariant = flipt.getVariant;
export const getFliptBoolean = flipt.getBoolean;
export const isFliptSync = flipt.isEnabledSync;
export const ensureFliptInitialized = flipt.ensureInitialized;
// Eval-cache counters for ~/server/metrics/flipt-eval-cache.metrics. Closes over the
// caches (no `this`), so unbinding here is safe — same as the accessors above.
export const getFliptCacheStats = flipt.getCacheStats;
// The underlying SDK client (or `null` before init), for a short-lived process that must
// `close()` it on the way out — its config poller is a timer that otherwise keeps the
// process alive. `getClientSync` closes over the instance (no `this`), like the above.
export const getFliptClientSync = flipt.getClientSync;
// A `FLIPT_LOCAL_OVERRIDES` value for one flag (never set in production), for a gate that reads the
// SDK client directly and would otherwise not see it.
export const getFliptLocalOverride = (flag: string): string | undefined =>
  flipt.config.localOverrides[flag];

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
