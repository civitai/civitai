import { redis, REDIS_KEYS } from '~/server/redis/client';

/**
 * Per-token fixed-window rate limit for the App Blocks catalog endpoints
 * (`/api/v1/blocks/models`, `/api/v1/blocks/images`).
 *
 * WHY: both catalog endpoints accept ANY valid block token and force
 * `Cache-Control: private, no-store` (so Cloudflare can't absorb the load — see
 * each endpoint's doc + withBlockScope). A security audit flagged (MEDIUM,
 * optional): with no per-token ceiling, a single block could shift catalog cost
 * onto the origin by hammering these routes. This bounds that without touching
 * the maturity-clamp authority surface.
 *
 * PATTERN: this reuses the established blocks fixed-window limiter — the SAME
 * INCR + EXPIRE + fail-open shape as `BlockTokenService.checkRateLimit` (the
 * per-token mint limiter) and the moderator-endpoint MULTI limiter. It runs on the
 * `redis` cache client (like the mint limiter), NOT the createLimiter / sysRedis
 * DB-count limiter (that one is a sliding count of a fetched DB value — wrong
 * tool for a fast burst ceiling).
 *
 * KEY: keyed on `claims.blockInstanceId` (the stable per-instance identity that
 * the same in-block iframe reuses across a paginating session) under a distinct
 * `:catalog:` sub-namespace, so this bucket NEVER contends with the mint-token
 * bucket (`TOKEN_RATE_LIMIT:<subject>:<blockInstanceId>`). We key on the
 * instance — not `jti` — because `jti` rotates on every re-mint (the host
 * re-mints a fresh token periodically), which would reset the window and let an
 * abuser churn tokens for a fresh bucket; `blockInstanceId` is stable per
 * install and is exactly what we want to throttle.
 *
 * FAIL-OPEN: any redis error/timeout returns `allowed:true` — the catalog must
 * never break because the limiter's redis is down. Mirrors
 * `BlockTokenService.checkRateLimit`.
 */

// CEILING: generous for a real in-block browser, bounded for abuse. A model/
// image selector paginates ~100 items/page; a user scrolling fast (or a
// debounced search firing as they type) issues at most a handful of fetches per
// second — well under this. The ceiling only bites a token issuing a sustained
// burst (>~12 req/s averaged over the window — 120 requests / 10s, so the 121st
// request in any 10s window trips it), which is not legitimate selector usage.
// Window is short so a tripped instance recovers within seconds.
//
// 🔴 TWO THINGS ABOUT THIS BUCKET THAT THE PARAGRAPH ABOVE DOES NOT SAY, BOTH
// SURFACED BY clawgate #569 AND BOTH LEFT AS THEY ARE RATHER THAN CHANGED — the
// number is live and moving it is a separate decision with its own blast radius.
//
//   1. THE KEY IS NOT PER-PERSON, THOUGH EVERY SENTENCE ABOVE REASONS AS IF IT WERE.
//      `blockInstanceId` is one viewer's iframe for a MODEL-SLOT install, but for a
//      PAGE app it is the synthetic `page_<appBlockId>` and for a platform default
//      it is `'pdb_' || app_block_id` — one string shared by EVERY concurrent viewer
//      of that app, platform-wide. So for those surfaces "120 per 10 s" is an
//      app-wide ceiling, not a per-user one, and one viewer can be refused because
//      of strangers' traffic. The new `:poll:` bucket below does NOT inherit this:
//      it puts the viewer in the key, and says why.
//   2. ITS TENANCY GREW, SO THE CEILING MOVED WITH IT — clawgate #569 plus its round-0
//      audit. #569 first added FIVE bridge procedures to this bucket against an
//      UNCHANGED ceiling sized for "a model/image selector" alone. That is a tightening
//      of five limits the change never intended to touch, on a key that is shared
//      platform-wide per app, and it is not excused by the key being pre-existing: this
//      was the change that raised the tenancy, so it owned the consequence.
//
//      Two things were done about it rather than one.
//
//      (a) TWO OF THE FIVE WERE WITHDRAWN. `listMyWorkflows` and `updateUserSettings`
//          are back to no limit; each one's own justification had conceded a margin of
//          10³–10⁴, which is a limit that bounds nothing while spending a shared
//          allowance. The reasons are recorded at those procedures.
//      (b) THE CEILING WAS RAISED, and the number is derived rather than picked. A page
//          app's load previously charged this bucket roughly four times (`getMyViewer`,
//          `getImagesByIds`, and 2 REST catalog calls); with `getMyBuzzBalance` — the
//          one surviving addition at page-load frequency — it charges roughly five. So
//          the app-wide concurrent-page-load headroom fell by a fifth. 150 = 120 × 5/4
//          restores it exactly. `cancelWorkflow` and `estimateWorkflow`, the other two
//          survivors, are user-action-driven rather than per-load and do not enter this
//          arithmetic.
//
//      ⚠️ RAISING IS THE SAFE DIRECTION AND IT IS NOT FREE. It loosens the bound for the
//      8 REST endpoints on this counter too, which never asked for it. That is accepted
//      knowingly: on a surface whose whole measured traffic is ~1,037 REST requests over
//      15 days, a 25% looser abuse ceiling is a smaller risk than throttling a legitimate
//      app, and this card's blast radius is explicitly asymmetric in that direction.
//
// **Closing condition for revisiting this ceiling and this key:
// `civitai_app_block_bridge_rate_limit_refusals_total` (added alongside this, in
// `~/server/metrics/app-block-runtime.metrics`) shows refusals on this bucket, or a GA
// week passes with none.** That series is what makes the sentence above checkable rather
// than merely reasonable.
export const BLOCK_CATALOG_RATE_LIMIT_MAX = 150;
export const BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS = 10;

// PUBLISH bucket (blocks.publishGenerationOutputs). A publish is FAR heavier than
// a catalog read — each image is a fetch + S3 upload + scan cycle — so it gets its
// OWN window/ceiling keyed by IMAGES (weight = image count), NOT one token per
// call. 60 published images / 5-minute window is generous for a real benchmark
// grid (which publishes a handful of results once) but hard-caps a token that
// tries to drive a sustained fetch/upload/scan fan-out onto the origin.
export const BLOCK_PUBLISH_RATE_LIMIT_MAX = 60;
export const BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS = 300;

// POST bucket (blocks.createPostFromApp). A DEDICATED bucket, not a share of the
// publish one, because the two limit different things and the wrong unit gives
// the wrong answer in both directions:
//
//   - PUBLISH is weighted by IMAGES and bounds ORIGIN COST (fetch + S3 upload +
//     scan per image). 60 images / 5 min is generous there.
//   - POST is weighted by POSTS and bounds PUBLIC-FEED IMPACT + REWARD EXPOSURE.
//     A single post is cheap to serve and expensive to un-do: it carries the
//     viewer's byline into the feed, and (with `modelVersionId`) pays a model
//     owner. Charging posts against the image bucket would let one 3-image post
//     and one 60-image publish trade against each other, which is incoherent.
//
// 3 posts / hour / block instance. A real app posts a finished result once; three
// gives room for a mistake and a retry without opening a spam faucet. The window
// is long ON PURPOSE — unlike the catalog bucket (where a short window means a
// tripped instance recovers in seconds, which is what you want for a read), a
// short window here would let a block post continuously at the ceiling.
//
// ⚠️ STATED LIMITS, so nobody reads this as more than it is: the bucket is keyed
// on `blockInstanceId` (the same choice, for the same `jti`-churn reason, as the
// other two), it is a FIXED window so a 2× burst across a boundary is reachable
// by construction, and it FAILS OPEN on a Redis error. It is a cost ceiling, not
// a security control. The controls that actually bound abuse are the self-dealing
// guard, the per-source ownership proofs, and the per-post consent confirm.
export const BLOCK_POST_RATE_LIMIT_MAX = 3;
export const BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS = 3600;

// APP-AGGREGATE post bucket, keyed on `claims.appId`. The per-instance bucket
// above bounds ONE INSTALL, so an app with N installs can post N × 3 per hour and
// no ceiling anywhere sees the total. This is the aggregate the per-instance
// bucket cannot express.
//
// 🔴 HOW THE NUMBER WAS CHOSEN, STATED PLAINLY BECAUSE IT IS NOT DATA-DERIVED.
// It is 100 × the per-instance ceiling: an app has to have 100 DISTINCT installs
// each posting at their own hourly maximum, in the same hour, before this engages
// at all. That is the whole rationale — there is no measurement behind it, and
// the per-instance 3/hour it multiplies is itself an acknowledged guess. It is a
// STARTING VALUE to be revised from the `block_scope_invocations` audit rows once
// a real app has run on this path; the rows record every post outcome per app, so
// the observed per-app hourly distribution is exactly what should replace it.
//
// DELIBERATELY GENEROUS, because the two failure directions are not symmetric. A
// too-tight aggregate throttles a popular, legitimate app and reaches its users
// as "posting is broken" — a quiet, diffuse failure that nobody attributes to a
// rate limit — while a too-loose one leaves a bounded amount of content that the
// self-dealing guard, the per-source ownership proofs and the per-post consent
// confirm have each already refused to admit on their own terms. Err loose.
//
// ⚠️ SAME STATED LIMITS AS THE BUCKET ABOVE: fixed window (a 2× burst across a
// boundary is reachable by construction) and FAILS OPEN on a Redis error. It is a
// cost ceiling, not a security control.
export const BLOCK_POST_APP_RATE_LIMIT_MAX = 300;
export const BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS = 3600;

// POLL bucket (blocks.pollWorkflow). A FOURTH bucket rather than a share of the
// catalog one — clawgate #569 asked for that choice to be argued rather than
// assumed, so here is the argument, in three parts.
//
//   1. WRONG COUPLING. `pollWorkflow` is the highest-frequency proc on the
//      bridge BY CONSTRUCTION: its cadence is set by how long a generation takes,
//      not by anything a person does. Sharing the catalog bucket would make every
//      OTHER proc's effective ceiling a function of that cadence — a block with
//      four generations in flight would find its model picker refusing, which is
//      the "looks like a broken block" failure this card is trying not to cause.
//   2. DIFFERENT SIZING QUANTITY. The catalog ceiling is sized against a human
//      scrolling a selector (a handful of fetches/second). Poll is sized against
//      concurrent workflows × cadence. Those are not the same number and forcing
//      them to share one means whichever is larger silently sets both.
//   3. DIFFERENT UNIT COST. A catalog read is one DB query. A poll is an
//      orchestrator GET — held OPEN for up to `MAX_BLOCK_POLL_WAIT_SECONDS` (15)
//      when the caller opts into the long poll — followed by an inline output
//      moderation scan. They occupy the origin differently.
//
// 🔴 KEYED ON THE INSTALL **AND THE VIEWER**, WHICH IS THE ONE PLACE THIS BUCKET
// DEPARTS FROM ITS FOUR SIBLINGS. They key on `blockInstanceId` alone, and for a
// MODEL-SLOT install that really is one viewer's iframe. For a PAGE app it is not:
// `src/pages/api/v1/block-tokens/index.ts` requires the synthetic `page_<appBlockId>`
// form, and `block-registry.service.ts` mints `'pdb_' || app_block_id` for platform
// defaults — ONE STRING SHARED BY EVERY CONCURRENT VIEWER OF THAT APP, platform-wide.
// Page apps are exactly the poll-heavy shape (a generator page is a page app), so a
// ceiling keyed on the instance alone would be a GLOBAL PER-APP poll ceiling: past it,
// one viewer's generations would be throttled by strangers' traffic, and a successful
// app would throttle its own users. Every sentence below reasons about one person, so
// the key has to be one person. `userId` is the self-bound token subject, never client
// input, and `blockInstanceId` is still in the key so the `jti`-churn argument the
// siblings make (a re-mint must not buy a fresh bucket) holds unchanged.
//
// 🔴 HOW THE NUMBER WAS CHOSEN, STATED PLAINLY BECAUSE IT IS NOT DATA-DERIVED — AND
// THE EVIDENCE BASE IS THINNER THAN AN EARLIER REVISION OF THIS COMMENT CLAIMED.
// That revision said "the whole App Blocks surface served ~1,037
// `civitai_app_block_requests_total` events over 15 days across 4 app_block_ids". The
// figure is real, but the metric is REST-ONLY: it is incremented at exactly one site,
// inside the `withBlockScope` wrapper in `src/server/middleware/block-scope.middleware.ts`,
// and is registered as "App Block REST requests". **It never counts a bridge call.**
// Every procedure this file's `:poll:` bucket bounds is on the tRPC bridge, so that
// number is evidence about a DIFFERENT surface, and there is no Prometheus series that
// counts a bridge request at all. What is honestly known: the platform runs 4 mod-gated
// app blocks, so bridge poll volume is certainly small — but it has never been observed,
// and the ceiling below is sized against the SDK's documented cadence, not against data.
//
// 1200 requests / 60 s = 20/s sustained, per (install, viewer). Against the cadences the
// `pollWorkflow` docblock names:
//   - the SDK's sequential short poll is ~1 per 2 s per workflow (0.5/s) — this is ~40×
//     that for one workflow, or ~4× a viewer running ten concurrent generations;
//   - the long poll would be ~1 per 15 s per workflow, i.e. 30× looser again. ⚠️ NO HOLD
//     REACHES THE SERVER TODAY — still true as of #5068, see immediately below for why
//     that is now a statement about ADOPTION rather than about a choke point — AND THE
//     REASON IS NARROWER THAN AN EARLIER REVISION OF THIS COMMENT CLAIMED, a difference
//     that matters to anyone sizing for GA.
//
//     🔴 #5068 REMOVES THE CHOKE POINT, WITHOUT (YET) CHANGING THE OBSERVATION.
//     `/api/v1/blocks/workflows/poll` takes `waitSeconds` STRAIGHT OFF THE WIRE and
//     forwards it, with no host in the path at all — so for that transport the host
//     choke point named below is GONE, and `@civitai/blocks-react`'s `watch` defaults
//     the field to 15, meaning the first block to adopt the REST twin holds from day
//     one. Until one does, no hold reaches the server, which is why the line above
//     still holds. ⚠️ An earlier revision of THIS paragraph said "the server sees no
//     hold IS NO LONGER TRUE" — that was an overstatement in the other direction and
//     contradicted both the line above it and the paragraph below it. The precise
//     claim is: the barrier is gone, nothing is through it yet.
//
//     🔴 STATE THE STATUS PRECISELY — an earlier wording of THIS paragraph said the
//     ~300-concurrent-hold figure below is "LIVE, not prospective", and that is not
//     established. What IS established: the hold is now REACHABLE and no longer
//     choked by a host. What is NOT: that anything is holding today — at the time
//     this route merges, NO shipped client calls it (a whole-tree sweep of
//     `civitai-app-starters` finds zero references to `/api/v1/blocks/workflows/*`),
//     and `pollOnce` sends `waitSeconds` over the BRIDGE, where the hosts still drop
//     it. So the correct reading is: the choke point is gone, the first REST adopter
//     starts holding at a 15 s default, and the concurrency cap this calls for is
//     still not implemented. Size for it; do not claim it is already happening.
//
//     What WAS MEASURED here, and still holds for the BRIDGE only: neither host passes
//     `waitSeconds` — zero occurrences of the identifier in `components/AppBlocks/` —
//     and `@civitai/app-sdk`'s `POLL_WORKFLOW` payload type (0.14.0, the version this
//     repo installs) carries `requestId` and `workflowId` only. The hosts are the choke
//     point, so the BRIDGE sees no hold.
//
//     What that earlier revision got WRONG: it generalised from the app-sdk payload to
//     "no shipped client takes that path". The round-0 audit reports that
//     `@civitai/blocks-react` (0.53.1) DOES send `waitSeconds` from `pollOnce`, with
//     `watch` defaulting it to 15 — and the server already accepts the field. That
//     package is not installed in this repo, so it is recorded here as the audit's
//     finding rather than as something measured at this call site. ✅ IT HOLDS, and this
//     hedge is now RESOLVED rather than left standing beside the paragraph above that
//     asserts it: `DEFAULT_WATCH_WAIT_SECONDS = 15` in
//     `packages/civitai-blocks-react/src/hooks/useBuzzWorkflow.ts` (v0.57.1). So blocks
//     ARE already asking and the bridge hosts ARE dropping it: over the BRIDGE the
//     ~300-concurrent-hold figure below is one line in each host away. Over the REST
//     twin the host is gone entirely and no line is needed — see the paragraph above
//     for what that does and does not mean. Size for it rather than against it.
//   - the pathological shape the resolver warns about — `setInterval(poll, 2000)` against
//     a 15 s hold, stacking ~7 concurrent requests per workflow — fits at ~5 concurrent
//     workflows for one viewer.
// A malicious block spinning a tight loop does thousands per second, so this still
// removes two-plus orders of magnitude from the abuse case while leaving every honest
// cadence untouched.
//
// ⚠️ THIS IS A RATE CEILING AND THE RESOURCE THAT ACTUALLY FAILS IS CONCURRENCY. With a
// 15 s hold, 20/s sustained is ~300 simultaneously-held request slots per (install,
// viewer) by Little's law, and `pollWorkflow` is a plain `publicProcedure` with no
// bulkhead admission control. Nothing here caps concurrent holds; this bucket does not
// pretend to. That is the number a GA reviewer should be looking at, and the control for
// it is a concurrency cap, not a smaller rate.
//
// DELIBERATELY GENEROUS, because the two failure directions are not symmetric: a
// too-tight poll ceiling degrades a generation the viewer already paid for, while a
// too-loose one leaves a bounded amount of orchestrator load. Err loose, and tighten on
// evidence.
//
// ⚠️ AND THE EVIDENCE DOES NOT EXIST YET — an earlier revision named a source that is
// structurally empty for this path. `pollWorkflow` writes NO `block_scope_invocations`
// row (that audit is written by the REST wrapper; the bridge has no equivalent), so the
// per-instance poll distribution "that should replace this" would never accumulate.
//
// 🔴 #5068 CHANGES THE SHAPE OF THAT GAP RATHER THAN CLOSING IT, and the new problem is
// the opposite one. The REST twin IS wrapped, so `/workflows/poll` writes one
// `dbWrite.blockScopeInvocation.create` PER REQUEST — unbatched, unsampled — turning a
// zero-write path into a primary-DB write stream bounded only by the 1200/60s ceiling
// above. For scale: the whole block REST surface was ~1,037 requests over 15 days across
// 4 apps; one viewer polling at 0.5 Hz matches that in ~35 minutes. So the poll
// distribution this comment wanted will now accumulate — at a cost nobody has sized, and
// on the primary rather than on a counter. **Open decision, deliberately not taken in
// #5068: whether poll should write an audit row at all.** Dropping it is cheap and is
// also a security-relevant removal on a spend-adjacent surface, which is why it is not
// being done as a performance tweak.
// **What would create it: a counter on bridge calls and on limiter refusals, labelled by
// procedure and bucket. Closing condition for revisiting this ceiling: that counter
// exists and has recorded a full GA week.**
//
// 🔴 A 60 s WINDOW, NOT THE CATALOG'S 10 s, AND THAT IS NOT COSMETIC. One long poll can
// occupy 15 s of wall clock on its own, so a 10 s window is shorter than a single
// legitimate request — a block issuing a small burst as a batch starts could trip a short
// window while its average rate sat far below the ceiling. 60 s is long enough that the
// ceiling describes a RATE rather than a burst.
//
// ⚠️ STATED LIMITS, so nobody reads this as more than it is: a FIXED window, so a 2×
// burst across a boundary is reachable by construction, and it FAILS OPEN on a Redis
// error. It BOUNDS ABUSE; it does not guarantee a ceiling. And unlike its siblings, a
// refusal here does NOT throw — see `pollWorkflow`, where returning rather than throwing
// is load-bearing rather than stylistic.
export const BLOCK_POLL_RATE_LIMIT_MAX = 1200;
export const BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS = 60;

export type BlockCatalogRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * THE SHARED FIXED-WINDOW BODY. Every bucket in this file is this function with a
 * different key prefix and a different pair of constants.
 *
 * 🔴 WHY IT IS ONE FUNCTION NOW. It used to be written out once per bucket, and the
 * fifth copy (the `:poll:` bucket, clawgate #569) is what made that untenable. Three
 * sibling files in this directory — `shared-storage-rate-limit.ts`,
 * `public-api-rate-limit.ts`, `app-moderator-message-rate-limit.ts` — already
 * factored the identical body into a local `checkFixedWindow` and carry eight
 * buckets between them with zero copies. The reason one of them gives is the one
 * that matters: *"shared by both counters so the two ceilings cannot drift in their
 * TTL self-heal or their retry-after arithmetic — the duplication this replaces is
 * what lets one of a pair of limiters quietly become TTL-less."*
 *
 * The drift is not hypothetical: `block-tip-rate-limit.ts` is the same copied body with
 * its `catch` flipped to fail-CLOSED, while every comment here asserts fail-open is the
 * convention every blocks limiter follows. ⚠️ BUT BE PRECISE ABOUT WHAT THIS HELPER
 * DELIVERS, because an earlier revision cited that drift as though consolidating this
 * file addressed it. It does not: `block-tip-rate-limit.ts` is a DIFFERENT MODULE, it is
 * untouched here, and no guard in the repo would notice if a third copy appeared
 * tomorrow. What this helper buys is that the FIVE buckets in THIS file can no longer
 * diverge from each other — which is exactly what made the fail-closed reply defect
 * below a one-line fix instead of a five-line one. The cross-file convention remains
 * unenforced. **Closing condition: a guard that pins every blocks limiter's `catch` to
 * fail-open, or a single shared module all of them call.**
 *
 * @param weight how much this call costs. 1 for a per-call bucket; the image count
 *   for the publish bucket, whose expense is per image rather than per request. The
 *   TTL is armed when the counter comes back EQUAL to the weight, which is the only
 *   value it can have on the first call of a fresh window.
 *
 * ⚠️ TWO PROPERTIES THIS SHAPE HAS, both inherited and both stated rather than fixed
 * here, because changing them would change five live ceilings at once:
 *
 *   1. FIXED window, not sliding — so a 2× burst across a boundary is reachable by
 *      construction. Every ceiling in this file is a cost bound, not a guarantee.
 *   2. INCR-then-EXPIRE is not atomic, so a crash or a reaped command between the two
 *      strands a key with NO TTL. The `ttl < 0` re-assert below self-heals it on that
 *      key's next call, bounding the over-count at one — but a key whose caller never
 *      returns stays immortal. The structural fix is the `MULTI: SET key 0 NX EX w` +
 *      `INCR key` shape, which arms the TTL in the command that CREATES the key and
 *      is what six other limiters in this repo already use
 *      (`src/server/utils/apps-catalog-rate-limit.ts` is the closest sibling). It is
 *      deliberately NOT taken in #569: that card is about which procedures get a
 *      decision, and swapping the command shape underneath five live buckets is a
 *      separate change with its own verification. **Closing condition: a PR that moves
 *      this one body to the MULTI shape and leaves all five buckets' unit suites
 *      green.**
 */
async function checkFixedWindow(
  key: string,
  max: number,
  windowSeconds: number,
  weight = 1
): Promise<BlockCatalogRateLimitResult> {
  try {
    const count = await redis.incrBy(key as never, weight);
    // 🔴 FAIL OPEN ON A NON-THROWING BAD REPLY, NOT JUST ON A THROW. Without this the
    // whole family fails CLOSED in the one failure mode a `catch` cannot see: a reply of
    // `undefined`/`null` makes `count <= max` FALSE — `undefined <= 150` is false — so
    // every caller is refused while every docblock in this file, the router call sites
    // and the decision ledger all promise unconditional fail-open. A `catch` is a guard
    // against THROWS; this is the guard against ANSWERS.
    //
    // ⚠️ CALL IT WHAT IT IS: A LATENT DEFECT, DEMONSTRATED AGAINST A TEST DOUBLE. The
    // round-0 audit reproduced the fail-closed behaviour on the pre-fix file with a
    // positive control, so the CODE defect is real and this line is the right fix. What
    // is NOT established is that any production client can produce such a reply:
    // `packages/civitai-redis/src/client.ts` types `incrBy` as `Promise<number>`, and
    // every failure path found in that client — the deadline wrapper, the cluster-routing
    // retry, the single-shot runner — REJECTS rather than resolving to a non-number. So
    // this is a guard against a contract violation nobody has observed, not a fix for a
    // live incident, and an earlier revision of the PR that called it "a production bug"
    // overstated it. It is cheap, it is correct, and it costs one `typeof`.
    if (typeof count !== 'number' || !Number.isFinite(count)) return { allowed: true };
    if (count === weight) {
      await redis.expire(key as never, windowSeconds);
    } else {
      // Re-assert a lost TTL — see property (2) above.
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, windowSeconds);
    }

    if (count <= max) return { allowed: true };

    // Over the ceiling — surface the remaining window as Retry-After. If the TTL read
    // fails or is unset (-1/-2), fall back to the full window so the caller backs off
    // sanely rather than retrying immediately.
    let retryAfter = await redis.ttl(key as never);
    if (!Number.isFinite(retryAfter) || retryAfter < 1) retryAfter = windowSeconds;
    return { allowed: false, retryAfterSeconds: retryAfter };
  } catch {
    // 🔴 FAIL OPEN, for every bucket in this file. A redis incident must never break a
    // catalog read, a publish, a post or an in-flight generation. It is what makes
    // every ceiling here a bound on ABUSE rather than a guaranteed cap, and each
    // caller's comment says so.
    return { allowed: true };
  }
}

/**
 * Records one catalog request against `blockInstanceId`'s window and reports
 * whether it is within the per-token ceiling.
 *
 * @param blockInstanceId stable per-instance identity from `req.blockClaims`.
 * @returns `{ allowed: true }` under the limit (or on any redis error —
 *   fail-open); `{ allowed: false, retryAfterSeconds }` once the window's count
 *   exceeds the ceiling.
 */
export async function checkBlockCatalogRateLimit(
  blockInstanceId: string
): Promise<BlockCatalogRateLimitResult> {
  return checkFixedWindow(
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:catalog:${blockInstanceId}`,
    BLOCK_CATALOG_RATE_LIMIT_MAX,
    BLOCK_CATALOG_RATE_LIMIT_WINDOW_SECONDS
  );
}

/**
 * Records a PUBLISH of `weight` images against `blockInstanceId`'s publish window
 * and reports whether it is within the per-token ceiling. Distinct `:publish:`
 * sub-namespace so it NEVER contends with the catalog-read or mint buckets. The
 * cost is WEIGHTED by image count (a 20-image publish spends 20 tokens), because
 * the expense is per-image (fetch + S3 upload + scan), not per-call. Same
 * fail-open posture as the catalog limiter.
 *
 * @param blockInstanceId stable per-instance identity from the verified token.
 * @param imageCount number of images this publish will materialise (weight ≥ 1).
 */
export async function checkBlockPublishRateLimit(
  blockInstanceId: string,
  imageCount: number
): Promise<BlockCatalogRateLimitResult> {
  return checkFixedWindow(
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:publish:${blockInstanceId}`,
    BLOCK_PUBLISH_RATE_LIMIT_MAX,
    BLOCK_PUBLISH_RATE_LIMIT_WINDOW_SECONDS,
    Math.max(1, Math.floor(imageCount))
  );
}

/**
 * Records ONE post against `blockInstanceId`'s post window and reports whether it
 * is within the per-instance ceiling. Distinct `:post:` sub-namespace so it can
 * NEVER contend with the catalog-read, publish or mint buckets.
 *
 * Weight is always 1 — a post is the unit, regardless of how many images it
 * carries. The per-image origin cost of adopting/persisting those images is
 * charged SEPARATELY against the publish bucket by the caller, so a block cannot
 * use the post path to bypass the image ceiling.
 *
 * Same fail-open posture as the sibling limiters: a Redis incident must not break
 * a legitimate post. See the ceiling constants above for what this bucket is and
 * is not.
 */
export async function checkBlockPostRateLimit(
  blockInstanceId: string
): Promise<BlockCatalogRateLimitResult> {
  return checkFixedWindow(
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:post:${blockInstanceId}`,
    BLOCK_POST_RATE_LIMIT_MAX,
    BLOCK_POST_RATE_LIMIT_WINDOW_SECONDS
  );
}

/**
 * Records ONE poll against this (install, viewer)'s poll window and reports whether
 * it is within the ceiling. Distinct `:poll:` sub-namespace so it can NEVER contend
 * with the catalog-read, publish, post or mint buckets — that non-contention IS the
 * reason this bucket exists (see the constants above).
 *
 * @param blockInstanceId the stable per-install identity from the verified token.
 * @param userId the SELF-BOUND token subject — never client input. It is in the key
 *   because `blockInstanceId` is `page_<appBlockId>` for a page app, i.e. shared by
 *   every viewer of it; without this half the ceiling would be app-wide and one
 *   viewer's generations would be throttled by strangers'. Argued at the constants.
 *
 * Weight is always 1: a poll is a poll, and the long-poll variant costs the origin
 * MORE per call rather than less, so weighting by hold duration would charge the
 * cheaper shape more. The long poll's effect on load is that it reduces the NUMBER
 * of calls, which this bucket already sees directly.
 *
 * Same fail-open posture as every sibling limiter. 🔴 But unlike them, the CALLER
 * must not turn a refusal into a throw: `pollWorkflow` returns a non-terminal
 * snapshot instead, because both hosts convert any throw from that mutation into a
 * `status: 'failed'` snapshot, which the SDK treats as terminal — so a thrown 429
 * ends the watch loop on a generation the viewer has already paid for. The reasoning
 * lives at the call site; this note exists so a second caller does not inherit the
 * fail-open posture and miss the return-don't-throw one.
 */
export async function checkBlockPollRateLimit(
  blockInstanceId: string,
  userId: number
): Promise<BlockCatalogRateLimitResult> {
  return checkFixedWindow(
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:poll:${blockInstanceId}:${userId}`,
    BLOCK_POLL_RATE_LIMIT_MAX,
    BLOCK_POLL_RATE_LIMIT_WINDOW_SECONDS
  );
}

/**
 * Records ONE post against `appId`'s AGGREGATE post window — the ceiling the
 * per-instance bucket structurally cannot express, because it is keyed on the
 * install and an app has many of those.
 *
 * Distinct `:post-app:` sub-namespace so it can never contend with the
 * per-instance `:post:` bucket, the publish, catalog or mint buckets. Weight is
 * always 1, the same unit as the per-instance bucket, so the two numbers are
 * directly comparable.
 *
 * 🔴 ADDITIVE, NOT A REPLACEMENT. The caller checks BOTH; either refusing refuses
 * the post. Neither subsumes the other: the per-instance bucket stops one install
 * spamming, this one stops an app aggregating that allowance across installs.
 *
 * Same fail-open posture as every sibling limiter — a Redis incident must not
 * break a legitimate post. See `BLOCK_POST_APP_RATE_LIMIT_MAX` for how the
 * ceiling was chosen and why it is not derived from data.
 */
export async function checkBlockPostAppRateLimit(
  appId: string
): Promise<BlockCatalogRateLimitResult> {
  return checkFixedWindow(
    `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:post-app:${appId}`,
    BLOCK_POST_APP_RATE_LIMIT_MAX,
    BLOCK_POST_APP_RATE_LIMIT_WINDOW_SECONDS
  );
}
