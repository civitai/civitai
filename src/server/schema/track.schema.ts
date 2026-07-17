import * as z from 'zod';
import { trackedReasons } from '~/utils/login-helpers';

export const addViewSchema = z.object({
  type: z.enum([
    'ProfileView',
    'ImageView',
    'PostView',
    'ModelView',
    'ModelVersionView',
    'ArticleView',
    'BountyView',
    'BountyEntryView',
  ]),
  entityType: z.enum([
    'User',
    'Image',
    'Post',
    'Model',
    'ModelVersion',
    'Article',
    'Bounty',
    'BountyEntry',
  ]),
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
  // 'no_token', 'error', 'error_boundary'). Drives the bounded `error_class`
  // label on `civitai_app_block_renders_total` (via `normalizeErrorClass`, which
  // clamps any value outside the known set to 'other'). It is STILL stripped from
  // the ClickHouse insert — it never reaches the tracker payload, only the prom
  // label.
  errorClass: z.string().trim().min(1).max(64).optional(),
});

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
//      'legacy' and 'new' (v2): both gate on prompt similarity >= 0.75.
//                v2 uses the `useRemixOfId()` hook (FormFooter.tsx:803),
//                which returns `undefined` when below threshold; legacy
//                applies the equivalent gate before mutate(). The hook
//                feeds `!!remixOfId` into the emit at FormFooter.tsx:913,
//                so an unsimilar remix correctly produces hasRemixOfId:false.
//                The thresholds are identical — legacy ≡ v2 here.
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
    // True when remixOfId is being sent on the request — gated by the
    // 0.75 prompt-similarity threshold via the `useRemixOfId()` hook in the
    // v2 form. See the doc-block above for the hasRemixOfId roll-up caveat.
    hasRemixOfId: z.boolean().optional(),
    // 'new' (generation_v2/FormFooter) is emitted by the current form.
    // 'legacy'/'video' are retained for backward-compatibility with
    // historical events from the removed legacy generation form.
    formVersion: z.enum(['legacy', 'new', 'video']).optional(),
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
    externalId: z.string().max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
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
]);

// One coalesced telemetry event in a /api/track/batch payload. `kind` selects the
// destination (search -> Tracker.search, action -> Tracker.action) and `data` is
// the EXACT existing per-event input for that destination. No field is added,
// dropped, or reshaped — the transport changes, the recorded row does not.
export const trackBatchEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), data: trackSearchSchema }),
  z.object({ kind: z.literal('action'), data: trackActionSchema }),
]);
export type TrackBatchEvent = z.infer<typeof trackBatchEventSchema>;

// The whole batch: an ordered, bounded array of events. Order is preserved end to
// end (client buffer -> array -> server iterates in order), matching the pre-batch
// emit order. Bounded to TRACK_BATCH_MAX so a malicious/oversized body is rejected
// at the schema layer before any Tracker dispatch.
export const trackBatchSchema = z.array(trackBatchEventSchema).min(1).max(TRACK_BATCH_MAX);
export type TrackBatchInput = z.infer<typeof trackBatchSchema>;

// Conversion/monetization-critical `addAction` kinds that must NOT be held in the
// coalescing buffer — enqueueing one triggers an immediate flush so a browser
// crash (which sendBeacon can't cover — it only fires on navigation/tab-hide)
// can't lose it. Everything else (all searches + the high-VOLUME top-of-funnel
// clicks) batches on the interval/size/unload triggers, which is where the load
// win lives (these confirms are low-volume).
//
// Selection is deliberately CONSERVATIVE — when in doubt an event is treated as
// high-value (immediate). Included:
//   - Generator_Submit      — anchors the generation→revenue funnel (externalId join)
//   - PurchaseFunds_Confirm — buzz purchase completion (real money)
//   - PurchaseFunds_Cancel  — checkout-funnel drop-off (purchase funnel)
//   - NotEnoughFunds        — purchase-funnel signal (insufficient balance)
//   - Tip_Confirm           — buzz tip send (money moves)
//   - AddToBounty_Confirm   — buzz committed to a bounty
//   - AwardBounty_Confirm   — buzz awarded from a bounty
//   - Membership_Cancel     — subscription churn
//   - Membership_Downgrade  — subscription downgrade
// Batched (low-value, high-volume or non-monetization): the *_Click intents,
// TipInteractive_Click/_Cancel (pre-confirm/cancel UI steps — the money move is
// Tip_Confirm), LoginRedirect, ProfanitySearch, CSAM_Help_Triggered,
// Model_Create_Click, Image_Remix_Click, and every trackSearch event.
export const HIGH_VALUE_ACTION_TYPES = new Set<TrackActionInput['type']>([
  'Generator_Submit',
  'PurchaseFunds_Confirm',
  'PurchaseFunds_Cancel',
  'NotEnoughFunds',
  'Tip_Confirm',
  'AddToBounty_Confirm',
  'AwardBounty_Confirm',
  'Membership_Cancel',
  'Membership_Downgrade',
]);

// A batch event is high-value only when it's an `action` whose type is in the set
// above. Searches are never high-value (they're the bulk of the volume → always
// batched). Used by the client buffer to decide immediate-flush vs coalesce.
export function isHighValueTrackEvent(event: TrackBatchEvent): boolean {
  return event.kind === 'action' && HIGH_VALUE_ACTION_TYPES.has(event.data.type);
}
