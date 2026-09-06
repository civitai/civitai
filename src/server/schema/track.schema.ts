import * as z from 'zod';
import { trackedReasons } from '~/utils/login-helpers';

// Both lists mirror the `views` / `daily_views` Enum8 columns, ordered by the ordinal the column stores —
// so index + 1 is that ordinal, and the test's snapshot pins it. A value the columns carry but these omit is
// unreachable: `TrackView` is typed from this schema, and a payload the `/api/internal/pulse` beacon rejects
// gets a 400 nobody looks at, since `sendView` never inspects the response. `Tracker`'s ViewType /
// ViewEntityType derive from these, so the two cannot drift apart.
export const VIEW_TYPES = [
  'ProfileView',
  'ImageView',
  'PostView',
  'ModelView',
  'ModelVersionView',
  'ArticleView',
  'CollectionView',
  'BountyView',
  'BountyEntryView',
  'ComicProjectView',
  'ComicChapterView',
  'Model3DView',
] as const;

export const VIEW_ENTITY_TYPES = [
  'User',
  'Image',
  'Post',
  'Model',
  'ModelVersion',
  'Article',
  'Collection',
  'Bounty',
  'BountyEntry',
  'ComicProject',
  'ComicChapter',
  'Model3D',
] as const;

export const addViewSchema = z.object({
  type: z.enum(VIEW_TYPES),
  entityType: z.enum(VIEW_ENTITY_TYPES),
  entityId: z.number(),
  ads: z.enum(['Member', 'Blocked', 'Served', 'Off']).optional(),
  nsfw: z.boolean().optional(),
  details: z.object({}).passthrough().optional(),
  nsfwLevel: z.number().optional(),
  browsingLevel: z.number().optional(),
});

export type AddViewSchema = z.infer<typeof addViewSchema>;

// App Blocks Analytics Phase 2 — block render/impression event.
//
// `block_scope_invocations` (Postgres) only captures AUTHENTICATED scoped API
// calls, so anon viewers and static/no-scope blocks (which never make a scoped
// call) are invisible. This event fires once per host mount at the BLOCK_READY
// transition to make those renders measurable. It is emitted via the lightweight
// /api/track/block-render beacon (see that route) rather than a tRPC mutation,
// to skip the per-request tRPC middleware cost at GA volume.
//
// GRANULARITY: this is ONE row PER HOST MOUNT. A tab-switch or model-navigation
// remount RE-FIRES it, so the same viewer can produce multiple rows for the
// "same" block view. Consumers computing "unique views" MUST dedup in-query
// (e.g. by viewer/session over a window) — do NOT treat each row as a unique view.
//
// SECURITY: the client supplies ONLY the three identifiers below. `isAnon` is
// derived server-side from the session (`!session?.user` in the beacon route)
// and `userId` is stamped by the Tracker — neither is accepted from the client
// (the non-strict object strips any client-sent isAnon/userId), so an anon
// viewer can't spoof an authed render (or vice-versa).
export type BlockRenderInput = z.infer<typeof blockRenderSchema>;
export const blockRenderSchema = z.object({
  // The approved AppBlock's id (UUID-ish string). Capped to keep a tampered
  // client from bloating the tracker payload; well above any real id length.
  appBlockId: z.string().trim().min(1).max(256),
  // The block instance id (`page_<appBlockId>` for pages, or the per-slot
  // install instance id for slot hosts).
  blockInstanceId: z.string().trim().min(1).max(256),
  // Where the block rendered: 'app.page' for the full-page runner, or a slot
  // id like 'model.sidebar_top' for the in-page slot host.
  slotId: z.string().trim().min(1).max(128),
  // Render outcome. Defaults to 'ok' (legacy beacons + the BLOCK_READY success
  // path omit it). 'error' is fired by the host on a genuine render failure
  // (error-boundary trip, or the iframe never reaching BLOCK_READY within its
  // timeout). Drives the `civitai_app_block_renders_total{result}` prom counter.
  status: z.enum(['ok', 'error']).default('ok'),
  // Optional low-cardinality failure discriminator (e.g. 'timeout', 'fatal',
  // 'no_token', 'error', 'error_boundary', 'token_lost_midsession'). Drives the bounded `error_class`
  // label on `civitai_app_block_renders_total` (via `normalizeErrorClass`, which
  // clamps any value outside the known set to 'other'). It is STILL stripped from
  // the ClickHouse insert — it never reaches the tracker payload, only the prom
  // label.
  errorClass: z.string().trim().min(1).max(64).optional(),
  // 🔴 SECONDARY (follow-up) BEACON — drives the prom counter ONLY, never a
  // `blockRenders` ClickHouse row.
  //
  // `blockRenders` is an IMPRESSION table: historically one host mount emitted
  // exactly ONE beacon (`ok` XOR `error`), so one mount == one row, and every
  // CH-derived figure counts rows as impressions.
  //
  // A host may now emit a SECOND beacon for the same mount when an outcome it
  // already reported later changes — today: a page that rendered fine and then
  // lost its credential mid-session (`token_lost_midsession`). That is a status
  // UPDATE about an impression already counted, NOT a new impression. Since the
  // CH row carries no status, a second row would be byte-identical to the first
  // and therefore impossible to de-duplicate after the fact — silently inflating
  // impressions/renders for exactly the sessions that suffered a revocation.
  //
  // So the emitter marks the follow-up and the server skips the insert for it.
  // 🔴 The discriminator is deliberately THIS FLAG and not `status === 'error'`:
  // a LAUNCH failure is a mount's ONLY beacon and MUST still write its row (it
  // is a real attempted render). What is suppressed is specifically a second
  // beacon for a mount that already reported.
  secondary: z.boolean().optional().default(false),
  // 🔴 OPTIONAL LAUNCH TIMINGS — carried on the EXISTING beacon, deliberately.
  //
  // There is exactly ONE /api/track/block-render beacon per host mount (guarded
  // by `blockRenderEmittedRef`, with ok/error mutually exclusive). A second
  // beacon for timing would break that contract and, more concretely, write a
  // second `blockRenders` ClickHouse row for one mount — byte-identical to the
  // first and therefore undedupable, inflating every impression figure. So the
  // timings ride as optional fields on the beacon that already fires, and
  // impression accounting is provably unchanged: same beacon count, same row
  // count, same `renders_total` increments.
  //
  // 🔴 LIKE status/errorClass/secondary, THIS IS STRIPPED BY *BOTH* WRITERS
  // BEFORE THE CLICKHOUSE INSERT — see `blockRenderTrackerPayload` below, which
  // exists precisely so there is one place to strip rather than two that can
  // drift. TypeScript cannot catch a missed strip here: `ctx.track.blockRender({
  // ...renderData, isAnon })` spreads, and spread properties are exempt from
  // excess-property checking, so an extra field compiles cleanly and lands in
  // the insert payload.
  //
  // 🔴 NUMBERS ONLY — no client-supplied strings, so nothing here can become a
  // prom LABEL. The `phase` label is code-owned: the server maps these three
  // named fields onto its own three literals. That is what keeps a public,
  // client-controlled beacon body from touching cardinality at all.
  //
  // Bounds: every leg is a non-negative millisecond count. `max` is a coarse
  // sanity bound only — the REAL gate is `launchSampleSeconds` server-side
  // (>0 and <= MAX_APP_BLOCK_LAUNCH_SECONDS, DROPPED not clamped), which the
  // client mirrors.
  //
  // 🔴 `.catch(undefined)` IS LOAD-BEARING, NOT DEFENSIVE CLUTTER. Without it a
  // malformed `timings` (a client bug producing a NaN, a stale field name, a
  // future rename) fails the WHOLE `blockRenderSchema.safeParse`, the beacon
  // route 400s, and the mount's IMPRESSION is lost — an observability add-on
  // would have broken the analytics series it was bolted onto. With it, junk
  // timings degrade to "no timings" and the impression is recorded exactly as
  // before. The add-on must be strictly subordinate to the thing it rides on.
  timings: z
    .object({
      totalMs: z.number().finite().nonnegative().max(600_000),
      tokenMintMs: z.number().finite().nonnegative().max(600_000).optional(),
      initWaitMs: z.number().finite().nonnegative().max(600_000).optional(),
      // 🔴 A COUNT, NOT A DURATION — how many BLOCK_INIT posts the host made
      // before the block acked. It is what discriminates the two mutually
      // exclusive explanations for `init_wait`'s 0.4-0.6s mode: re-post
      // quantization (>=2 posts) vs. a block that simply boots that slowly
      // (1 post). Without it the histogram cannot say which, and cannot show
      // whether tuning the re-post cadence changed anything.
      //
      // 🔴 DELIBERATELY LOOSE HERE, exactly like the durations above: no
      // `.int()`, and a coarse `max`. This object carries `.catch(undefined)`,
      // so a STRICT rule here would let one malformed count discard the whole
      // `timings` object — the client's own bug would silently delete the
      // DURATION samples too. The real gate is `launchInitPostsSample`
      // server-side (integer, >0, <= MAX_APP_BLOCK_LAUNCH_INIT_POSTS, DROPPED
      // not clamped), mirrored client-side by `boundedInitPosts`.
      //
      // Still a NUMBER, so like every field here it can never become a prom
      // label — the histogram it feeds carries no labels at all.
      initPosts: z.number().finite().nonnegative().max(100_000).optional(),
      // 🔴 THE STRATIFIER, and it is a BOOLEAN — never a client-supplied string.
      // The server maps it onto its own two literals (`yes`/`no`), so nothing a
      // client sends can become a prom label value. That is the same rule the
      // `phase` label follows and the reason this beacon body can stay public.
      //
      // MEANING: the guest sent BLOCK_HELLO at some point during the launch —
      // NOT "the accelerator fired an extra post". See `LaunchMarks.helloSeen`.
      //
      // 🔴 OPTIONAL HERE, BUT ABSENCE IS NOT `false`. A client that predates this
      // field omits it; a launch that genuinely saw no hello sends `false`. The
      // server must tell those apart — it labels the second `no` and the first
      // `unknown` (a real bucket, never a drop: dropping would cut coverage of
      // an existing metric, and cut it in a latency-correlated way) — so this
      // stays `.optional()` rather than `.default(false)`, which
      // would erase the distinction at the parse boundary and silently file every
      // stale-client launch into the `no` population this metric exists to
      // isolate.
      hello: z.boolean().optional(),
    })
    .optional()
    .catch(undefined),
});

/**
 * 🔴 THE SINGLE STRIP POINT FOR THE `blockRenders` CLICKHOUSE PAYLOAD.
 *
 * There are TWO writers of that table — the REST beacon
 * (`src/pages/api/track/block-render.ts`) and the `track.blockRender` tRPC
 * procedure (`src/server/routers/track.router.ts`) — and every prom-only /
 * observability field added to `blockRenderSchema` has to be removed on BOTH.
 * Patching one is a SILENT half-fix: the field falls through the other's
 * `...renderData` spread straight into the insert, and TypeScript does not
 * complain because spread properties are exempt from excess-property checking.
 *
 * 🔴 IT IS AN ALLOWLIST, NOT A DESTRUCTURE-REST. Both writers previously did
 * `const { status, errorClass, secondary, ...renderData } = input` — which is a
 * DENYLIST: every field added to the schema is forwarded to ClickHouse by
 * DEFAULT and stays silent until someone reads the CH payload. Naming the three
 * real columns instead inverts that: a new schema field can never reach the
 * insert, and adding a genuine new column is a deliberate edit here.
 */
export function blockRenderTrackerPayload(input: BlockRenderInput): {
  appBlockId: string;
  blockInstanceId: string;
  slotId: string;
} {
  return {
    appBlockId: input.appBlockId,
    blockInstanceId: input.blockInstanceId,
    slotId: input.slotId,
  };
}

export type TrackShareInput = z.infer<typeof trackShareSchema>;
export const trackShareSchema = z.object({
  platform: z.enum(['reddit', 'twitter', 'clipboard']),
  url: z.url().trim().nonempty(),
});

export type TrackSearchInput = z.infer<typeof trackSearchSchema>;
export const trackSearchSchema = z.object({
  query: z.string().trim(),
  index: z.string(),
  filters: z.object({}).passthrough().optional(),
});

// action tracking schemas

const tipClickSchema = z.object({
  type: z.literal('Tip_Click'),
  details: z
    .object({
      toUserId: z.number(),
      entityId: z.number().nullish(),
      entityType: z.string().nullish(),
    })
    .optional(),
});
const tipConfirmSchema = z.object({
  type: z.literal('Tip_Confirm'),
  details: z
    .object({
      toUserId: z.number(),
      entityId: z.number().nullish(),
      entityType: z.string().nullish(),
      amount: z.number(),
    })
    .optional(),
});
const tipInteractiveClickSchema = z.object({
  type: z.literal('TipInteractive_Click'),
  details: z
    .object({
      toUserId: z.number(),
      entityId: z.number(),
      entityType: z.string(),
      amount: z.number(),
    })
    .optional(),
});
const tipInteractiveCancelSchema = z.object({
  type: z.literal('TipInteractive_Cancel'),
  details: z
    .object({
      toUserId: z.number(),
      entityId: z.number(),
      entityType: z.string(),
      amount: z.number(),
    })
    .optional(),
});
const notEnoughFundsSchema = z.object({
  type: z.literal('NotEnoughFunds'),
  details: z.object({ amount: z.number() }).optional(),
});
const purchaseFundsCancelSchema = z.object({
  type: z.literal('PurchaseFunds_Cancel'),
  details: z.object({ step: z.number() }).optional(),
});
const purchaseFundsConfirmSchema = z.object({
  type: z.literal('PurchaseFunds_Confirm'),
  details: z
    .object({
      priceId: z.string().optional(),
      buzzAmount: z.number(),
      unitAmount: z.number(),
      method: z.string(),
    })
    .optional(),
});
const loginRedirectSchema = z.object({
  type: z.literal('LoginRedirect'),
  reason: z.enum(trackedReasons),
});

const membershipCancelSchema = z.object({
  type: z.literal('Membership_Cancel'),
  details: z
    .object({
      reason: z.string(),
      from: z.string(),
    })
    .passthrough()
    .optional(),
});

const membershipDowngradeSchema = z.object({
  type: z.literal('Membership_Downgrade'),
  details: z
    .object({
      reason: z.string(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const csamHelpTriggeredSchema = z.object({
  type: z.literal('CSAM_Help_Triggered'),
  details: z
    .object({
      query: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const profanitySearchSchema = z.object({
  type: z.literal('ProfanitySearch'),
  details: z
    .looseObject({
      query: z.string().optional(),
      matches: z.array(z.string()).optional(),
    })
    .optional(),
});

// Generation funnel telemetry — top-of-funnel click events that feed into
// the existing orchestration.jobs / images_created / PurchaseFunds_Confirm
// downstream stages. See PR #2322 / civitai-observability-gaps dashboard.
const modelCreateClickSchema = z.object({
  type: z.literal('Model_Create_Click'),
  details: z
    .object({
      modelId: z.number().optional(),
      modelVersionId: z.number().optional(),
      // Free-form entry-point tag (matches data-activity values on the
      // GenerateButton). Canonical values as of pass 8:
      //   create:model, create:model-stat, create:model-card,
      //   create:version-stat, create:training-select, create:navbar,
      //   create:tool-banner, create:tool-card
      source: z.string().optional(),
    })
    .optional(),
});

// DEFINITION CHANGE, Aug 2026: this used to fire when the Remix button itself
// was clicked. The button now opens a menu, and the event fires when a menu
// option is chosen — so volume drops by the menu-abandonment rate across every
// surface at once, while the `source` values keep matching. On a funnel chart
// that reads as a conversion collapse; it is a change in what is counted.
// `remixKind` is absent on rows emitted before this date.
const imageRemixClickSchema = z.object({
  type: z.literal('Image_Remix_Click'),
  details: z
    .object({
      imageId: z.number(),
      // What the user clicked Remix on. Bounded to the three media types
      // surfaced by GetGenerationDataInput; keep this enum tight so a typo
      // or new value shows up at the schema layer rather than silently
      // showing as `other` in downstream funnel queries.
      imageType: z.enum(['image', 'video', 'audio']).optional(),
      // The primary checkpoint version the remix will seed into the generator,
      // when known on the client. Often unknown on infinite-scroll cards
      // (resolved server-side by getGenerationData) — nullable on purpose.
      sourceModelVersionId: z.number().nullish(),
      // Free-form entry-point tag (matches data-activity values: remix:image,
      // remix:image-card, remix:image-meta, etc.) — left as a string so new
      // remix entry-points can be added without a schema bump.
      source: z.string().optional(),
      // Which kind of remix was chosen from the menu. Kept out of `source` so
      // existing dashboards filtering on the bare entry-point tag keep matching.
      remixKind: z.enum(['edit', 'video', 'reuse']).optional(),
    })
    .optional(),
});

// Dashboard semantics for Generator_Submit — read before slicing the funnel:
//
//   isValid: true means "RHF validation + graph.validate() passed" — NOT
//     "reached orchestration". Downstream sanitize/buzz/mutate failures
//     (insufficient buzz, POI flag, mutate() rejection) still happen after
//     isValid:true and are observable only via orchestration.jobs or the
//     PurchaseFunds funnel.
//
//   isRateLimited: never co-emitted with the validation-fail signal. A submit
//     that is BOTH rate-limited AND has an invalid prompt only emits
//     isValid:false (no isRateLimited:true) — react-hook-form's onError
//     fires before GenForm's onSubmit wrapper can run the canGenerate
//     check (legacy), and v2's FormFooter explicitly runs graph.validate()
//     before the canGenerate check to match (see FormFooter.tsx:handleSubmit).
//     So the rate-limited path is unreachable from a validation-failed
//     submit on every form path. Treat `isRateLimited:true` as the lower
//     bound of capacity-bounded clicks, not the full set.
//
//     isValid value on rate-limited emits is path-dependent — the legacy
//     image and video forms emit isValid:false (the GenForm wrapper writes
//     it that way), while v2's FormFooter emits isValid:true (the submit
//     would have validated; only the cap stopped it). Queries filtering
//     `isRateLimited:true AND isValid:true` see ONLY v2; filtering
//     `isRateLimited:true AND isValid:false` sees legacy + video. The
//     dashboard should treat `isRateLimited:true` as the source of truth
//     for "capacity-bounded click" and ignore `isValid` on those rows.
//
//   hasRemixOfId semantics:
//      'new' (v2): true whenever the generator was opened from the remix
//                entry point. It no longer gates on prompt similarity — an
//                image edit or an image-to-video shares no prompt with its
//                source, so the old >=0.75 threshold dropped the link exactly
//                where the derivation was most literal. Historical 'legacy'
//                and pre-2026-08 'new' rows DO carry that gate, so a roll-up
//                across that boundary compares two different definitions.
//                Whether a derivation was actually verified is a separate
//                field on the image (meta.extra.sourceImageIds), not this one.
//      'video':  hasRemixOfId is NOT emitted (field absent in the details
//                payload — see VideoGenerationForm.tsx:153-165, 241-252).
//                Video form has no prompt-similarity hook yet; add when
//                video remix analytics matter.
//     A query GROUP BY hasRemixOfId is safe to roll up across formVersion
//     'legacy' and 'new', but should EXCLUDE 'video' (the field is missing,
//     not false) or split it out as its own bucket.
//
//   formVersion: absent on rate-limited emits from GenForm — the legacy
//     image GenForm wrapper and VideoGenerationForm don't have a way to
//     discriminate from the wrapping layer without a prop drill. v2's
//     FormFooter rate-limit emit does include formVersion:'new'. So
//     `isRateLimited:true AND formVersion missing` = legacy image or
//     video form; `isRateLimited:true AND formVersion:'new'` = v2.
//     Rate-limited GenForm emits are ONLY fired from the two opt-in call
//     sites (`<GenForm track>` in GenerationForm2 + VideoGenerationForm);
//     orchestrator modals (upscale / bg-removal / video-interpolation)
//     deliberately omit the rate-limited emit so they don't produce
//     asymmetric data — they have no success / validation-fail emits of
//     their own. Treat upscale/bg-removal/interpolation as out of this
//     funnel entirely until they get dedicated instrumentation.
//
//   source vs fromAction: Model_Create_Click{source:'create:navbar'} pairs
//     to Generator_Submit{fromAction:'direct'}, NOT 'create'. The navbar
//     Create button calls generationGraphPanel.open() with no input, which
//     resolves entry-action to 'direct' via the no-input branch. Same
//     pairing applies to source='create:tool-banner' and 'create:tool-card'
//     — both open the panel with no input (the tool alias is resolved
//     later, not at click time), so they also pair to fromAction='direct'.
//     The remaining create:* sources (create:model, create:model-stat,
//     create:model-card, create:version-stat, create:training-select)
//     pair to fromAction='create'. The wildcard CTA on
//     ModelVersionDetails.tsx emits source='create:model' too — wildcard
//     is a runType branch in the form provider, not a source tag. If
//     wildcard click→submit conversion ever becomes a question, the
//     instrumentation needs to differentiate via wildcardSetId, not source.
//     Per-source conversion queries against navbar/tool sources need:
//       JOIN clicks ON click.userId = submit.userId
//         WHERE click.source IN ('create:navbar','create:tool-banner','create:tool-card')
//           AND submit.fromAction IN ('create','direct')
//     The 'direct' bucket also contains non-click-attributed submits (panel
//     re-open, /generate page direct visit), so navbar/tool conversion is
//     an upper bound, not an exact count.
//
//     Note: source='create:version-stat' may emit with modelId=undefined
//     during the parent component's loading race (the modelVersion fetch
//     in ModelVersionEarlyAccessPurchase hasn't resolved yet, so
//     modelVersion?.model?.id is undefined when the user clicks). Dashboard
//     queries should treat 'create:version-stat AND modelId IS NULL' as
//     expected, not as a data issue.
//
//     Note: source='create:model-card' (RemixButton on ModelCard) intentionally
//     emits without modelId — the ModelCard caller doesn't have
//     ModelVersion.modelId in scope. Aggregate to parent model via a
//     ModelVersion lookup if you need model-level rollups.
//
//   Fetch-in-flight race: open({type:'image', id}) only writes
//     lastEntryAction AFTER fetchGenerationData() resolves (generation-graph
//     .store.ts:369-371). If a user clicks Remix and submits before the
//     source fetch resolves, fromAction reflects the prior session's value
//     (likely 'direct'), not 'remix'. RHF validation typically rejects
//     these submits (isValid:false — the form is still in skeleton/loading
//     state), so the visible artifact is a thin slice of
//     `fromAction='direct', isValid=false` rows that should have been
//     'remix'. Remix click→submit conversion will under-count by this
//     narrow slice. Not worth fixing until it shows up as a measurable
//     drift on the dashboard.
//
//   Orphan submits — known un-instrumented entry-points: several pre-existing
//     call sites open the generation panel without emitting a paired
//     Model_Create_Click / Image_Remix_Click, so their Generator_Submit rows
//     have no joinable upstream click event:
//       - pages/challenges/[id]/[[...slug]].tsx:154,1231 — challenge detail
//         "Generate" buttons (top-of-page + per-model-version action)
//       - components/Challenges/ChallengeInvitation.tsx:80,85 — challenge
//         invite modal accept
//       - components/Chopped/states/playing.tsx:288 — Chopped game's
//         "Create submission" button
//       - components/ImageGeneration/QueueItem.tsx:417-422 — in-queue
//         "Generate with this resource" button (runType:'run' → fromAction:
//         'create'; semantically a replay, but pre-existing — not changing
//         in this pass)
//       - components/generation_v2/inputs/MetadataExtractionPanel.tsx:170-179 —
//         "Add resources" handler in the metadata-extraction drop-zone calls
//         setData({runType:'run'}) (→ fromAction:'create') and opens the
//         panel with no upstream click emit. Low volume vs the other
//         orphan entry-points; instrumenting is follow-up scope.
//       - components/Buzz/FeatureCards/FeatureCards.tsx:148 — Buzz feature
//         card "Generate" entry. Opens the panel with no input (→ fromAction:
//         'direct'). Not instrumented in this pass — entry-point is on the
//         Buzz dashboard, semantically more of a marketing surface than the
//         core create/remix funnel; instrumenting is follow-up scope.
//     These produce Generator_Submit{fromAction:'create'} (or 'replay' for
//     runType='run' from QueueItem) with no matching click row. Dashboard
//     queries computing click→submit conversion should EITHER exclude
//     orphan-submits via `WHERE EXISTS (matching click within session)` OR
//     document the gap and treat the orphan slice as an additive baseline.
//     Instrumenting these entry-points is follow-up scope.
const generatorSubmitSchema = z.object({
  type: z.literal('Generator_Submit'),
  // `details` is marked required (not .optional()) so new callers can't
  // silently emit a Generator_Submit with no payload — that would land in
  // the funnel as an un-attributed row and skew every downstream query.
  // Inside `details`, only `fromAction` is required; the rest (isValid,
  // formVersion, isRateLimited, modelVersionId, hasRemixOfId) are advisory
  // and may be omitted depending on form/path. The submit-schema's job is
  // to enforce the entry-action discriminator, not to dictate which
  // optional context fields each emitter chooses to populate.
  details: z.object({
    // Checkpoint version that will run the job. May be undefined for
    // multi-resource workflows where the checkpoint isn't picked yet.
    modelVersionId: z.number().nullish(),
    // Discriminator for joining back to the entry-point click event.
    // Reflects the most-recent intentful entry, not session history — each
    // open-with-input call (remix click, model-stat click, replay) overwrites
    // the previous value; close() resets to 'direct'; navbar Create resets
    // to 'direct' via the no-input branch. So a user who remixes then
    // pivots to the navbar will see fromAction='direct' on the next submit,
    // not 'remix'.
    //
    // 'remix'  — opened from an image/video (generationGraphPanel runType=remix)
    // 'create' — opened from a model/modelVersion page or model card
    // 'replay' — re-run from the queue / previous output
    // 'direct' — opened from /generate or with no input (panel default)
    fromAction: z.enum(['create', 'remix', 'replay', 'direct']),
    // True when remixOfId is being sent on the request — i.e. the generator was
    // opened from the remix entry point. See the doc-block above: the meaning
    // changed when the prompt-similarity gate was removed.
    hasRemixOfId: z.boolean().optional(),
    // 'new' (generation_v2/FormFooter) is emitted by the current form;
    // 'form-graph' by the form-graph lane's footer. 'legacy'/'video' are
    // retained for backward-compatibility with historical events from the
    // removed legacy generation form.
    formVersion: z.enum(['legacy', 'new', 'video', 'form-graph']).optional(),
    // False when the submit attempt failed validation (react-hook-form
    // onError path or graph.validate() early return). The data team can
    // split valid-vs-invalid attempts to spot UX traps where users click
    // Generate but the form blocks them. Default true (omitted on success
    // path is treated as valid by downstream).
    isValid: z.boolean().optional(),
    // True when the submit short-circuits because the user is at their
    // concurrent-request limit (snapshot.canGenerate === false). Capacity-
    // bounded clicks show up as a distinct funnel stage and aren't
    // conflated with RHF validation failures (missing prompt, etc.).
    // isValid on these rows is path-dependent (legacy/video: false,
    // v2: true) — see the doc-block above for the dashboard caveat.
    isRateLimited: z.boolean().optional(),
    // Idempotency key also forwarded as `externalId` on the orchestration
    // create-workflow call. Lets the dashboard join Generator_Submit rows
    // to orchestration.jobs.externalId exactly (no userId+time heuristic).
    //
    // Present on happy-path emits (isValid:true, passed both RHF + the
    // inner graph.validate / canGenerate gates) — NOT on RHF-fail or
    // rate-limited emits, which never call mutateAsync. Note that some
    // happy-path emits still produce no orchestration row — the user can
    // cancel at the buzz-confirm prompt, hit insufficient-buzz, or trip
    // a POI/mature-content reject after submit. Those rows will have
    // externalId populated but never match a job; dashboard joins should
    // treat unmatched-externalId submits as "submitted, no workflow"
    // not "missing telemetry."
    //
    // Constraints mirror the orchestrator's own validation
    // (civitai/civitai-orchestration#229 WorkflowTemplate.ExternalId) so
    // tampered clients get rejected at the trpc layer instead of bloating
    // the trackAction body before the orchestrator rejects.
    externalId: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  }),
});

// Client-coalesced telemetry batch — high-volume `track.trackSearch` (~16/s) and
// `track.addAction` (~6.8/s) were each fired as ONE tRPC call per event, dragging
// the full non-batched tRPC middleware chain + superjson encode + ClickHouse
// insert per event (~23 procedures/s of pure telemetry). The browser now buffers
// them and flushes coalesced batches to the /api/track/batch beacon, which
// dispatches each event through the SAME Tracker.search()/Tracker.action() (byte-
// identical ClickHouse inserts) once per batch instead of once per event.
//
// Each batch element is discriminated by `kind` and carries the UNCHANGED
// per-event input under `data` — the search/action schemas below are reused
// verbatim, so nothing about what is recorded changes, only how it's transported.
// The array is bounded (min 1, max BATCH_MAX) so a tampered client can't bloat a
// single request; the browser flushes well below this cap (see trackEventBuffer).
// `trackBatchEventSchema` / `trackBatchSchema` are declared at the bottom of this
// file (after `trackActionSchema`, which the action arm references).
// Image/video feed tag bar click-through. This event is the CONDITION the bar ships
// under — a click-through floor was agreed, and the bar is removed if it is not met
// (ClickUp 868kv0cdr). The denominator is `pageViews` on /images and /videos; query
// strings never reach that table, so the path alone identifies the feed.
//
// `tag` is null for the All chip, which clears the filter rather than setting one.
// It is still a press, so it is recorded; a query measuring intent to NARROW
// should filter it out rather than assume it is absent.
const feedTagBarClickSchema = z.object({
  type: z.literal('Feed_TagBar_Click'),
  details: z.object({
    // Which feed the bar was pressed on.
    feed: z.enum(['images', 'videos']),
    // Chip name, or null for All. Bounded server-side by FEED_TAG_BAR_TAG_NAMES;
    // capped here so a tampered client cannot bloat the `details` String column.
    tag: z.string().trim().max(64).nullable(),
    tagId: z.number().nullable(),
    // Whether the press selected a chip or cleared back to the whole feed.
    action: z.enum(['select', 'clear']),
  }),
});

// Creator announcement analytics — the click half. The impression half rides the feed
// impression pipeline (`entityType: 'Announcement'`) and writes no `actions` row.
//
// `creatorId` is carried even though it is derivable from `announcementId` in Postgres:
// the Creator Studio read is a ClickHouse query and would otherwise need a join it has no
// table for. Both are ids, so neither can carry user text into the `details` column.
const announcementClickSchema = z.object({
  type: z.literal('Announcement_Click'),
  details: z.object({
    announcementId: z.number().int().positive(),
    creatorId: z.number().int().positive(),
  }),
});

// Mute and unmute of a creator's announcements. Two types rather than one carrying a
// boolean: the chart is `countIf(type = ...)` per day with no JSON parsing of `details`,
// and a net line is the difference of the two.
//
// 🔴 DELIBERATELY ABSENT FROM `trackActionSchema`. That schema is what `/api/track/batch`
// accepts from a browser, so an arm here would let anyone post mute events for any creator
// — which is the opposite of the property these two types exist to have. They are emitted
// only from the tRPC mutation that performs the mute. `BuzzLimit_Set` is the existing
// precedent for a server-only action type with no client arm.
//
// 🔴 THESE ARE THE ONLY RECORD OF A MUTE OVER TIME. `UserAnnouncementMute` is the live
// truth for "how many people have me muted right now", but an unmute DELETES the row, so
// a chart built from its `createdAt` shows only mutes that are still in force — a past
// day's bar shrinks as people unmute, and a mute-then-unmute never happened at all. These
// events are what make the series honest, so they must be emitted on BOTH edges.
//
// Emitted SERVER-SIDE from the tRPC mutation, not from the browser: unlike the impression
// beacon this number cannot be inflated by a script posting to /api/track/batch.

// App store play count — the `App_Open` half. (Blank line above is load-bearing: without
// it this block reads as a continuation of the mute pair's rationale directly overhead,
// and the play-count reasoning attaches to the wrong schemas.)
//
// 🔴 DELIBERATELY ABSENT FROM `trackActionSchema`, for the same reason as the mute pair
// above and `BuzzLimit_Set` before it: this schema is what `/api/track/batch` accepts from
// a browser, so an arm here would let anyone inflate ANY app's play count by POSTing —
// and unlike a chart in an admin page, that number is printed on a public marketplace card
// next to the review count. It is emitted SERVER-SIDE only, from the `/apps/run/<slug>`
// SSR resolver (`recordAppListingOpen`), i.e. from a request this server actually served
// after the flag gate, the approved-app resolution and the host rating check all passed.
//
// The containment direction in `action-type-enum-drift.test.ts` is what keeps this true in
// one direction (every arm here must be an `ActionType`); the reverse is deliberately not
// asserted, which is exactly what lets a server-only type exist.
export const TRACK_BATCH_MAX = 100;

export type TrackActionInput = z.infer<typeof trackActionSchema>;
export const trackActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('AddToBounty_Click') }),
  z.object({ type: z.literal('AddToBounty_Confirm') }),
  z.object({ type: z.literal('AwardBounty_Click') }),
  z.object({ type: z.literal('AwardBounty_Confirm') }),
  tipClickSchema,
  tipConfirmSchema,
  tipInteractiveClickSchema,
  tipInteractiveCancelSchema,
  notEnoughFundsSchema,
  purchaseFundsCancelSchema,
  purchaseFundsConfirmSchema,
  loginRedirectSchema,
  membershipCancelSchema,
  membershipDowngradeSchema,
  csamHelpTriggeredSchema,
  profanitySearchSchema,
  modelCreateClickSchema,
  imageRemixClickSchema,
  generatorSubmitSchema,
  feedTagBarClickSchema,
  announcementClickSchema,
]);

// Feed impression event — an entity was actually SEEN in a feed, as opposed to
// opened. `views` only records the latter, so every view count on the platform
// undercounts reach by however often people scroll past without clicking.
//
// One event carries MANY entities. That is the whole reason impressions are
// affordable: a feed session generates one impression every few hundred ms, and
// a per-entity event would put that rate on the wire. The browser instead holds
// a deduplicated set and ships it as a single array (see impressionBuffer.ts),
// so the request rate is set by the flush interval, not by scroll speed.
// Stored as LowCardinality(String), NOT Enum8. An Enum8 would make adding an
// entity type a schema change applied by hand to a raw table plus two rollups, in
// every environment, before the code that emits the new value can ship. A
// LowCardinality column costs the same at rest and accepts a new value the day
// someone adds a card. This list stays the authority on what the SERVER accepts —
// widening the storage does not widen what a browser can write.
export const IMPRESSION_ENTITY_TYPES = [
  'Image',
  'Model',
  'Post',
  'Article',
  'Collection',
  'Bounty',
  'BountyEntry',
  'User',
  // Creator announcements only. The sitewide rows render through the same card but are
  // not instrumented — nobody reads a reach number for those, and they would sit in the
  // same rollup a creator's page sums.
  'Announcement',
] as const;
export type ImpressionEntityType = (typeof IMPRESSION_ENTITY_TYPES)[number];

const IMPRESSION_ENTITY_TYPE_SET: ReadonlySet<string> = new Set(IMPRESSION_ENTITY_TYPES);

/** Narrows a loosely-typed entity type from a polymorphic card to a tracked one. */
export function isImpressionEntityType(value: string | undefined): value is ImpressionEntityType {
  return value !== undefined && IMPRESSION_ENTITY_TYPE_SET.has(value);
}

// Where the impression happened. Becomes a LowCardinality(String) column, so it
// is a closed enum rather than free text — a tampered client cannot introduce a
// new value and blow up the column's dictionary.
export const IMPRESSION_SURFACES = [
  'home',
  'images',
  'videos',
  'posts',
  'models',
  'articles',
  'collections',
  'bounties',
  'search',
  'user',
  'other',
] as const;
export type ImpressionSurface = (typeof IMPRESSION_SURFACES)[number];

// Entities per event. The browser flushes at this cap; the ceiling exists so a
// tampered body can't turn one request into an unbounded ClickHouse insert.
export const IMPRESSION_ENTITIES_MAX = 250;

export const trackImpressionSchema = z.object({
  // Random per-tab token, minted client-side and never persisted. NOT an
  // identifier: it exists so the SAME entity seen repeatedly during one browsing
  // session collapses to one impression, and so a batch redelivered by the
  // at-least-once transport can be recognised as a duplicate at read time
  // (`uniqExact(sessionKey)` over the raw table) rather than double-counted.
  sessionKey: z.string().min(1).max(32),
  // `.catch` rather than a hard reject: an unrecognised surface must not 400 a
  // batch that is otherwise full of good events.
  surface: z.enum(IMPRESSION_SURFACES).catch('other'),
  entities: z
    .array(
      z.object({
        entityType: z.enum(IMPRESSION_ENTITY_TYPES),
        entityId: z.number().int().positive(),
      })
    )
    .min(1)
    .max(IMPRESSION_ENTITIES_MAX),
});
export type TrackImpressionInput = z.infer<typeof trackImpressionSchema>;

// One coalesced telemetry event in a /api/track/batch payload. `kind` selects the
// destination (search -> Tracker.search, action -> Tracker.action) and `data` is
// the EXACT existing per-event input for that destination. No field is added,
// dropped, or reshaped — the transport changes, the recorded row does not.
export const trackBatchEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), data: trackSearchSchema }),
  z.object({ kind: z.literal('action'), data: trackActionSchema }),
  z.object({ kind: z.literal('impression'), data: trackImpressionSchema }),
]);
export type TrackBatchEvent = z.infer<typeof trackBatchEventSchema>;

// The whole batch: an ordered, bounded array of events. Order is preserved end to
// end (client buffer -> array -> server iterates in order), matching the pre-batch
// emit order. Bounded to TRACK_BATCH_MAX so a malicious/oversized body is rejected
// at the schema layer before any Tracker dispatch.
export const trackBatchSchema = z.array(trackBatchEventSchema).min(1).max(TRACK_BATCH_MAX);
export type TrackBatchInput = z.infer<typeof trackBatchSchema>;

// `addAction` kinds that must NOT be held in the coalescing buffer — enqueueing
// one triggers an immediate flush so a browser crash (which sendBeacon can't
// cover — it only fires on navigation/tab-hide) can't lose it. Everything else
// (all searches + the high-VOLUME top-of-funnel clicks) batches on the
// interval/size/unload triggers, which is where the load win lives (these
// immediate kinds are low-volume).
//
// Two categories qualify, selected CONSERVATIVELY (when in doubt → immediate):
//
//   MONEY / CONVERSION-critical:
//   - Generator_Submit      — anchors the generation→revenue funnel (externalId join)
//   - PurchaseFunds_Confirm — buzz purchase completion (real money)
//   - PurchaseFunds_Cancel  — checkout-funnel drop-off (purchase funnel)
//   - NotEnoughFunds        — purchase-funnel signal (insufficient balance)
//   - Tip_Confirm           — buzz tip send (money moves)
//   - AddToBounty_Confirm   — buzz committed to a bounty
//   - AwardBounty_Confirm   — buzz awarded from a bounty
//   - Membership_Cancel     — subscription churn
//   - Membership_Downgrade  — subscription downgrade
//
//   COMPLIANCE / SAFETY-critical:
//   - CSAM_Help_Triggered   — child-safety signal; must never be buffered/crash-lost
//
// Batched (low-value, high-volume or non-critical): the *_Click intents,
// TipInteractive_Click/_Cancel (pre-confirm/cancel UI steps — the money move is
// Tip_Confirm), LoginRedirect, ProfanitySearch, Model_Create_Click,
// Image_Remix_Click, and every trackSearch event.
export const IMMEDIATE_FLUSH_ACTION_TYPES = new Set<TrackActionInput['type']>([
  // money / conversion
  'Generator_Submit',
  'PurchaseFunds_Confirm',
  'PurchaseFunds_Cancel',
  'NotEnoughFunds',
  'Tip_Confirm',
  'AddToBounty_Confirm',
  'AwardBounty_Confirm',
  'Membership_Cancel',
  'Membership_Downgrade',
  // compliance / safety
  'CSAM_Help_Triggered',
]);

// A batch event flushes immediately only when it's an `action` whose type is in
// the set above. Searches are never immediate (they're the bulk of the volume →
// always batched). Used by the client buffer to decide immediate-flush vs coalesce.
export function isImmediateFlushTrackEvent(event: TrackBatchEvent): boolean {
  return event.kind === 'action' && IMMEDIATE_FLUSH_ACTION_TYPES.has(event.data.type);
}
