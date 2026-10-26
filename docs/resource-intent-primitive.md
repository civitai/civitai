# Resource-intent primitive (Jev)

**Status:** **M1 + the M2 consume seam** — the primitive and its REST surface, dark behind `resourceIntentJev` (default-deny), with the shortlist now ordered against the `ResourceInsight` labels. Stage 3 is the screened R4c design and the suggestions are the HYBRID_10 list — see [Stage 3 and the hybrid list](#stage-3-and-the-hybrid-list-hybrid_10). The candidate POOL is seeded by popularity alone and the labels act only through the re-rank on it; see [Label ordering](#label-ordering) for why. M3 (the gold-set study) grades stage-1 agreement AND carries a pre-registered two-arm retrieval comparison (the shipped matcher against its popularity seed alone); its registration v2 judged the previous, purpose-first seed NOT MET, and registration v3 (not yet run) grades the popularity seed — see [The M3 study](#the-m3-study-a-pre-registered-retrieval-comparison). M4/M5 are gated follow-ons — see [Rollout](#rollout).

A versioned, headless API primitive: **prompt → intent + criteria → civitai resource suggestions**. A prompt becomes a typed intent (what kinds of resources it wants, with full probability distributions), the intent compiles into a deterministic shortlist over the model search index, and a second judgment (two calls, averaged) picks the head of the list, which the popularity pool fills to the cap. `none` is a first-class answer at stage 1, where it returns no suggestions; stage 3's `none` is reported but never empties the list. Most prompts need no resource.

The judgment model is [TypeSafe Jev](https://openrouter.ai) (`typesafe/jev-1.13`) via OpenRouter — a bounded-judgment vendor: Choice (full distribution over ≤255 options), Score (ordered rubric), Noul (P(yes)). It cannot generate prose, count, or compare dates, so everything structural stays in deterministic code.

🔴 **Transport: `POST https://openrouter.ai/api/alpha/decisions`, never chat/completions.** `typesafe/jev-1.13` is a _decisions_ model; posting it to `/api/v1/chat/completions` returns HTTP 400 in ~200 ms with `"typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."` The first implementation of `services/ai/jev.ts` did exactly that — flattening its own `{state, questions}` contract into chat messages — so **every call this primitive ever made in production returned 400 and degraded to empty suggestions**, from its first request. It was found by one live call with two controls (the same key/endpoint/parameters with a chat model returns 200; the model's own metadata endpoint confirms it exists with `supported_parameters: []`, which was the tell all along), and it survived a six-round audit and a comprehensive green test suite because **that suite mocked the vendor**. A green suite over a mocked seam is a claim about the mock. The wire contract is documented in `src/server/services/ai/jev.ts`; OpenRouter publishes no docs page for it (`/docs/api-reference/decisions` → 404) and it is an **alpha** endpoint, so re-verify before relying on any detail.

Three consequences worth knowing before you read the rest of this document: `questions` and `answers` are **records keyed by id**, not arrays; a Score answer is an **index into its `criteria` array** (`0 … criteria.length - 1`), mapped back to the declared `min`/`max` by the adapter, which is why `askJev` refuses a question whose `criteria.length !== max - min + 1`; and a Noul answer carries **no confidence**, so any aggregate over an answer set must exclude it rather than default it to 0 (`jevConfidenceFloor`).

## Architecture

```
POST /api/v1/blocks/resource-intent {prompt, baseModel?, limit?, kind?, needs?}
  → [redis cache, key sha256(prompt|baseModel|browsingLevel|cap|specHash|stage3SpecHash), TTL 1h]
  → Jev request #1: 6 questions, one round trip      (src/server/services/ai/jev.ts)
  → criteria (versioned object, criteriaVersion: 2)  (src/server/schema/resource-intent.schema.ts)
  → matcher: Meilisearch models_v9 filtered, sorted by thumbs-up (one page; a second
      500-document page for basePool, every miss that reaches the matcher — see HYBRID_10)
      → version pool ≤ 2 x cap
      → ordered against ResourceInsight via `dbRead` (the Postgres read replica)
      → shortlist ≤ min(limit||50, 255) versions
      → basePool: its own 500-doc page, popularity order, 1 version per model,
        ≤ 2 x cap models (max 255)
  → Jev requests #2 and #3, in parallel: one Choice over the shortlist per option order
      (popularity, reverse), described `none`, probabilities averaged
  → HYBRID_10: stage 3's first 10 distinct models, basePool fills to the cap
  → response {intent, criteria, suggestions[], noneProbability, model, criteriaVersion,
              insightFallback}
  → shadow event → ClickHouse resourceIntentShadow   (graceful fallback to structured log)
```

The diagram is the default HYBRID_10 add-on path. POOL_MERGE and v1_tags keep stage 1, drop stage 3, and replace the matcher and cache key with their own; checkpoint mode drops stage 1 as well (see their sections); the v1_tags shadow and judge capture run after the response, beside the shadow event.

| File                                                     | Role                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/services/ai/jev.ts`                          | Vendor seam. Pinned model, fail-closed validation, 2s timeout.                                                                      |
| `src/server/schema/resource-intent.schema.ts`            | Question spec v1, criteria schema, role→ModelType mapping, spec hash.                                                               |
| `src/server/services/resource-intent.service.ts`         | Cache → stage 1 → criteria → matcher → stage 3 → hydration → shadow event. Plain async function; reusable without the REST surface. |
| `src/server/services/resource-intent-stage1.ts`          | Stage 1 as pure functions (request, answer parse, criteria compile), shared by the service and the M3 study. Imports only the schema and a jev type, so a standalone script can load it. |
| `src/server/services/resource-intent-stage3.ts`          | Stage 3 (R4c question, option orders, averaging) and the HYBRID_10 merge as pure functions, plus `RESOURCE_INTENT_STAGE3_SPEC_HASH`. Light, like stage 1, so a study script can import it. |
| `src/server/services/resource-intent-matcher.service.ts` | Deterministic gates + popularity-seeded pool + `ResourceInsight` ordering + hard cap, and the hybrid's one-version-per-model `basePool`. |
| `src/pages/api/v1/blocks/resource-intent.ts`             | Block-token REST surface.                                                                                                           |
| `src/shared/constants/hosted-model-catalog.constants.ts`, `src/server/services/resource-intent-hosted-models.ts` | The curated hosted-model catalog and its capability matcher, which answer `needs`. See [Hosted models](#hosted-models-needs--hostedmodels). |
| `scripts/label-resource-insights.ts`                     | The offline batch pass that WRITES `ResourceInsight`, and enqueues the labeled MODELS for reindex. Run manually; spends vendor budget on every invocation, dry run included. |
| `scripts/eval-resource-intent-goldset.ts`                | M3 gold-set study runner. No-ops without `--execute`. Samples the gold and grades stage-1 agreement, then runs the retrieval comparison below. |
| `scripts/eval-resource-intent-retrieval.ts`              | M3 two-arm retrieval comparison: the PURPOSE and POPULARITY arms, the metric math (hit@K, MRR, the non-inferiority bound, the MRR sign test), the MET / NOT MET / VOID verdict and its report. |
| `scripts/eval-resource-intent-registration.ts`           | M3's registration: the pre-registered constants and text, and the committed gold-set queries. No database or search client, so the dry run is hermetic. |
| `scripts/eval-resource-intent-goldset-execute.ts`         | The `--execute` half of the runner (replica, index, vendor), loaded only under `--execute`. |
| `src/server/services/resource-intent-pool-merge.ts` | The POOL_MERGE merge (`mergeReservedK`, copied from the screen; `backfillAfter` when the request has no `baseModel`) and `RESOURCE_INTENT_POOL_MERGE_SPEC_HASH`. Imports nothing from the app, so a study script can load it. See [The POOL_MERGE arm](#the-pool_merge-arm-co-occurrence). |
| `src/server/services/resource-intent-checkpoint.ts` | Checkpoint mode's arms (ATTACH_BM, BASE_BM), their constants and `RESOURCE_INTENT_CHECKPOINT_SPEC_HASH`. Imports nothing from the app. See [Checkpoint mode](#checkpoint-mode-kind-checkpoint). The builder half, `resource-intent-cooc/checkpoint-attach.ts`, counts checkpoint attachments per baseModel into a section of the co-occurrence snapshot. |
| `src/server/services/resource-intent-cooc/`, `scripts/build-resource-intent-cooc.ts` | The co-occurrence (token → model) retrieval arm. The request path reads it only on the POOL_MERGE arm, through `holder.ts`. The weekly `build-resource-intent-cooc` job is behind the default-off `resource-intent-cooc-build` Flipt flag. The daily, ungated `resource-intent-cooc-retention` job persists its heartbeat in `KeyValue`, exported as `civitai_app_resource_intent_cooc_retention_last_success_timestamp_seconds`. Snapshots are immutable and content-hashed, in `ResourceIntentCoocSnapshot`. The migration `20261011120000_resource_intent_cooc_snapshot` is applied by hand before the flag opens, and an external staleness alert on the heartbeat must exist before the first study snapshot. Its training eligibility is `GOLDSET_ELIGIBLE_IMAGE` after the window line, copied byte for byte (`resource-intent-cooc.eligibility.test.ts` fails if the two diverge). |
| `src/server/services/resource-intent-tags/`, `src/server/jobs/build-resource-intent-tag-index.ts`, `scripts/dry-run-resource-intent-tags-build.ts` | The v1 content-tag arm. The request path reads it only behind its own default-off flags (see [The v1_tags arm](#the-v1_tags-arm)). The weekly `build-resource-intent-tag-index` job (build, then retention) is behind the default-off `resource-intent-tag-index-build` Flipt flag; the dry run runs the same pipeline without storing. The per-pod holder (`holder.ts`) loads nothing unless the default-off `resource-intent-tag-index-holder` flag is on. See [v1 content tags (dark)](#v1-content-tags-dark). |

## Hard rules

1. **Pin the model.** `typesafe/jev-1.13` (numbered). `jev-latest` never appears in code. ⚠️ **This rule used to read "the client sends `allowFallbacks: false`, so OpenRouter cannot route the call to a different model while we record ours", and that is RETRACTED** — it described the chat/completions transport, which could never have worked at all (see the transport note below). The decisions endpoint's only proven request shape is `{model, state, questions}`, and sending an unverified `provider` key to a strictly-validated alpha endpoint is how the original defect happened. The pin is now enforced on the **response** instead: the vendor reports the build that answered (`typesafe/jev-1.13-20260917` for the pinned `typesafe/jev-1.13`), `askJev` fails closed on anything that is not the pin or a dated build of it, and `JevResponse.model` carries that vendor-reported build rather than our constant. That observes what actually ran instead of requesting a routing promise.
2. **Fail closed, fail empty.** Any Jev error/timeout/malformed response returns HTTP 200 with `degraded: true` and `suggestions: []`. Never a stack trace, never fabricated suggestions. 🔴 A **label**-read failure is deliberately NOT a degrade: on its own it produces a complete response with a real intent and real suggestions, flagged `insightFallback: true`, and `degraded` keeps meaning "the vendor path failed" so the invariants above (`suggestions: []`, `intent`/`criteria` `null`, `model: 'jev-unavailable'`) stay true of every degraded add-on row. (Checkpoint mode makes no vendor call; its degraded rows keep `suggestions: []` and `intent`/`criteria` `null` but report `model: 'checkpoint-unavailable'`, see [Checkpoint mode](#checkpoint-mode-kind-checkpoint).) ⚠️ The two are not exclusive: a label read can fail and a LATER stage degrade anyway, giving `degraded: true` **with** `insightFallback: true` and no suggestions — so `insightFallback` is only interpretable when `degraded` is false. Both take a short cache TTL, for different reasons — see [Caching](#caching-rate-limits-flag).
3. **Deterministic gates always win.** Availability (no Private), the token's `maxBrowsingLevel` maturity clamp (authoritative — no client maturity field is read), region restriction, canGenerate coverage, baseModel compatibility (the caller's exact name; on the v1_tags arm's own list, the ecosystem's compatible set for add-ons, whether the caller or the tags chose it, and the caller's exact name for checkpoints; a v1 fallback serves the POOL_MERGE list, which keeps the caller's exact name; never Jev output), and the hard-coded `celebrity` tag exclusion are applied in the matcher. Hydration re-checks exactly TWO of them — `hasAccess` and the maturity ceiling. Coverage, baseModel and the celebrity exclusion are NOT re-checked there, and `canGenerate` is present on the hydrated resource and unread. ⚠️ **No principle separates the two re-checked gates from the three that are not.** An earlier draft of this line said the re-checked ones are "the ones whose indexed value can lag"; that is false — the source comment beside the check says the _coverage_ filter is a superset that can lag, and coverage is gated on indexed Meili fields exactly like the rest. So the honest statement is that a version whose coverage lapsed since the last index build can still be suggested. Treat that as an accepted gap with no stated justification, not as a designed boundary — and if you close it, `canGenerate` is already on the object. Jev output only orders the stage-3 head and never adds: its options are positional keys into the gate-passing shortlist (plus `none`), and the `basePool` fill passes the same gates, so an unknown version is unrepresentable.
4. **`none` is a first-class answer at stage 1.** A stage-1 `role` argmax of `none` returns empty suggestions _without_ `degraded`. Stage 3 also offers a described `none`, but its averaged mass is only REPORTED (`noneProbability`, and the shadow's `stage3NoneProbability`) and never empties the list: the offline arm screen measured "stage-3 `none` argmax ⇒ empty" costing hit@10, and it was dropped.
5. **Stable question IDs + spec hash.** `QUESTION_SPEC_VERSION` plus a sha256 over the question spec ride every response and shadow row; a question edit invalidates old analytics instead of blending with them. 🔴 **The spec term in the CACHE KEY is the hash, not the version** — the hash moves on any spec edit, the hand-maintained integer only moves when someone remembers, and until that was fixed a reworded prompt would have left pre-edit entries served for their full hour under the new spec _and_ stamped into the shadow table with the new hash, which is precisely the blend this rule exists to prevent. Stage 3 has its own hash, `RESOURCE_INTENT_STAGE3_SPEC_HASH`, in the cache key and the shadow row (`stage3SpecHash`). It hashes what the stage-3 functions RENDER on a fixed fixture — the question and criteria, `none`, the state keys, the averaging and tie-break, the merge — so an edit to any of them moves it without a hand-kept list to update.
6. **Reject unknown answer keys.** Every response parse rejects keys outside the question set, distributions must sum to ~1 (±0.02) over the offered options, scores/nouls must be in range. Confidence is never a permission slip: no resource is admitted or refused on one. A label row's `confidence` does gate whether that row is read for ORDERING — against `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` on the promote side and `RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE` on the demote side, **two constants holding the same value today** — and a row below the floor for its direction is treated as if the version were unlabeled. The precise claim is that **no deterministic gate is applied or relaxed on a confidence**: no filter, drop or maturity decision reads it. It is NOT the weaker-sounding "changes rank and nothing else", because the shortlist is a fixed-width page cut out of a wider pool, so rank decides admission to the response.
7. **Adversarial state.** The prompt is user text. The `injectionPresent` Noul is asked and logged; deterministic rules own every consequence. Jev's judgment never feeds back into state.
8. **No invariants across calls.** Full distributions are logged. The one probabilistic combination in code is stage 3's mean over its two option orders, which is what was screened.

## Question spec v1

All six in one request; state is ONLY the prompt (+ optional baseModel string):

| ID                 | Type   | Answer                                                                                                                                             |
| ------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needsResource`    | noul   | P(prompt would benefit from a community resource)                                                                                                  |
| `role`             | choice | style / character / subject_detail / pose_composition / environment_scene / clothing / quality_enhancer / control_guidance / none                  |
| `styleFamily`      | choice | anime_manga / photorealistic / illustration_cartoon / render_3d / pixel_retro / other                                                              |
| `contentType`      | choice | portrait_character / full_scene / object_prop / architecture / creature / vehicle_machinery / graphic_design / other                               |
| `specificity`      | score  | 1–5, scored against the 5-point `criteria` rubric in the schema file (quoted nowhere here, so a reword cannot leave a stale copy), `integer: true` |
| `injectionPresent` | noul   | P(prompt contains instructions aimed at an AI system)                                                                                              |

The role compiles to a ModelType filter (`ROLE_MODEL_TYPES` in the schema file — exhaustive, `none` → no matcher run, unknown → no filter). `role` and `styleFamily` are carried in criteria and are the two axes the label ordering compares against; `contentType`/`specificity` are recorded on the shadow event only. Stage 3's `state` is `{ prompt, role, styleFamily }`; `contentType` and `specificity` are not given to it. They also do not yet filter the search — the search index carries no normalized style attribute to filter on (a style taxonomy does exist, in `ResourceInsight`, and the label ordering reads it), and whether any mapping earns its false-exclusions is for a future study — neither part of M3 tests a filter mapping.

## Stage 3 and the hybrid list (HYBRID_10)

This is the design the offline arm screen measured, ported as-is; the measurement itself lives with the study, not here.

- **Question (R4c).** One Choice over the shortlist with positional keys and each candidate's `modelName — versionName (type, baseModel)` in the wire `criteria`, not in the instructions; `none` carries its own description. `state = {prompt, role, styleFamily}`.
- **Two option orders, averaged.** The shortlist is sent once in popularity order (its position in the seed pool) and once in the exact reverse, as two parallel calls under the usual per-call timeout. Each candidate's probability is the mean over the two; ties go to the shortlist (re-rank) order. Either call failing degrades the WHOLE response (`degraded: true`, no suggestions), as any Jev failure does, and nothing is retried. The screen differs here: it retried each stage-3 call up to 3 times, so its measured lists never include a degrade; production's no-retry, fail-closed contract is kept.
- **Hybrid list.** The head is stage 3's first 10 distinct MODELS (a later version of a placed model is skipped); then the matcher's `basePool` — popularity order, the first gate-passing version of each model — fills to the cap, skipping placed models. A shortlist with fewer than 10 models is taken whole; an empty shortlist returns `basePool`'s top `cap`. The matcher builds `basePool` exactly as the screen built its BASE pool: its own 500-document page under the seed's filter and sort, reduced to one version per model, the first `2 × cap` models (capped at 255) in popularity order. It runs alongside the label read.
- **Cost.** Stage 3 is now **2 vendor calls per uncached request** (3 with stage 1). The screen's vendor-reported cost was about **$0.00011 per stage-3 call** over a 50-option shortlist, so about **$0.00022 per uncached request for stage 3**, plus about $0.000045 for stage 1. Cache hits cost nothing. A longer shortlist (a larger `limit`) costs more per call. Every uncached request that reaches the matcher also makes **one more Meilisearch query**, the 500-document `basePool` page, in parallel with the label read; it returns whole model documents, so its payload is the largest in the request.
- **Shadow.** `stage3SpecHash`, `stage1NoneProbability` and `stage3NoneProbability` (split, because `noneProbability` holds stage 3's value when it ran and stage 1's otherwise; `stage3NoneProbability` is NULL on a cache hit, since it is not cached) need `src/server/clickhouse/migrations/2026-10-08-resource-intent-shadow-stage3.sql`, applied by hand before the flag is opened anywhere.
- **Response.** Unchanged in shape. `noneProbability` keeps its meaning (stage 3's averaged value when it ran, else stage 1's). The cache key does move (stage-3 hash), so a deploy starts cold.

## The POOL_MERGE arm (co-occurrence)

Behind `resourceIntentPoolMerge` (read only once `resourceIntentJev` has opened the route), the suggestions are the co-occurrence screen's POOL_MERGE list (with a `baseModel`; see **Merge** for the unscreened no-`baseModel` order) instead of HYBRID_10. Stage 1 runs as before; there is no stage 3, so a request makes one vendor call.

- **Candidates.** The prompt's `coocQueryTokens`, scored by `rankCooc` against the served snapshot, for the role's model types, top 300.
- **Gate.** The candidates under the matcher's own filter AND `id IN candidates`, one unsorted page as wide as the candidate list, re-sorted by candidate rank, one version per model (`findPoolMergeCandidates`). The first 50 are the co-occurrence list.
- **Merge.** `mergeReservedK(coocList, basePool, 25, 50)`: up to 25 co-occurrence models, interleaved first with BASE's popularity models (one version per model, from the 500-document page). BASE is 100 models wide whatever the `limit`. 🔴 **That interleave applies only with a `baseModel`**, the case the screen measured, where BASE is popularity within the ecosystem. Without one the filter has no ecosystem clause and BASE is global popularity, so interleaving it put the same popular add-ons in every other slot of every such response whatever the prompt. So with no `baseModel`, `backfillAfter(coocList, basePool, 50)` lists the whole co-occurrence list first in its own order (up to 50, not 25) and BASE only fills the slots it leaves, deduplicated (`poolMergeModelIds(..., { interleaveBase })`, decided by `findPoolMergeCandidates` from the seed's `baseModels`). A prompt with no gated co-occurrence models, or no servable snapshot, still gets pure global popularity. This no-`baseModel` order was not screened. 🔴 **This arm returns at most 50 suggestions**: a `limit` above 50 still gets these 50, because wider lists were never screened, and a narrower `limit` gets this list's prefix. That differs from HYBRID_10, which fills to any `limit` up to 255.
- **Snapshot.** `coocSnapshotHolder` serves the newest ready production snapshot, checked every 5–6 minutes (jittered per pod), loaded once per change and shared by concurrent requests; a check running past 2 minutes is abandoned and retried 60 s later; with nothing held, only requests arriving in a load's first 10 s wait for it (up to 10 s), later ones get the fallback at once; it refuses a snapshot built under a different `RESOURCE_INTENT_COOC_SPEC_HASH`, or whose stored bytes fail verification (content hash, kind, size, structure), and does not download that snapshot again until a different one becomes the newest; a database or network failure, or Node, V8 or brotli failing to allocate memory while decoding, is retried 60 s later. **With no servable snapshot** the arm returns BASE's top `min(limit, 50)` through the same gates, with `coocFallback: true`, a 60 s cache and a logged `resource-intent-cooc-fallback` reason (`no_snapshot`, `load_failed`, `spec_mismatch`, `snapshot_unservable` when the stored bytes fail verification, or `loading` while the first load is slow).
- 🔴 **Before opening `resourceIntentPoolMerge`:** enable the weekly cooc build (the `resource-intent-cooc-build` flag) and confirm a ready production snapshot exists, one built under the current `RESOURCE_INTENT_COOC_SPEC_HASH`. **After any change to the cooc spec, run a production build by hand** before that change is served. Why: `no_snapshot`, `spec_mismatch` and `snapshot_unservable` are not transient. Each lasts until a build lands, which on the weekly schedule can be days, and the fallback response is cached for only 60 s. For that whole time, each distinct prompt that keeps being asked costs a fresh vendor call every 60 s instead of once an hour. The 60 s TTL is kept on purpose, so a fallback clears soon after a snapshot loads; these preconditions are what keep the fallback rare.
- **Study mode.** `ctx.coocSnapshotId` (a study snapshot's content hash) serves this arm from that pinned snapshot. It fails closed — `degraded: true`, no vendor call, no cache read or write — if the snapshot is missing, not a study snapshot, built under another spec, or past its pin. It never falls back.
- **Cache key.** Adds `pool_merge`, the snapshot's content hash (`fallback` when none is served), `RESOURCE_INTENT_COOC_SPEC_HASH` and `RESOURCE_INTENT_POOL_MERGE_SPEC_HASH`. The HYBRID_10 key is unchanged.
- **Shadow.** `arm`, `coocSnapshotHash`, `coocSpecHash`, `poolMergeSpecHash`, `coocFallback`, `coocFallbackReason` are sent on POOL_MERGE rows, on checkpoint rows, and on served v1_tags rows (where they describe the POOL_MERGE fallback list and are blank on v1's own). They need `src/server/clickhouse/migrations/2026-10-10-resource-intent-shadow-pool-merge.sql`, applied by hand before any of `resourceIntentPoolMerge`, `resourceIntentCheckpoint` or `resourceIntentV1` opens anywhere; HYBRID_10 rows read the columns' defaults.

## Checkpoint mode (`kind: 'checkpoint'`)

A request with `kind: 'checkpoint'` asks for checkpoints instead of add-ons. It needs `baseModel` (the caller's ecosystem, matched exactly — not expanded to its family as `getPopularCheckpointForEcosystem` in `src/server/services/blocks/checkpoint.service.ts` does). It must be one of the known base-model names (`baseModels` from `src/shared/constants/basemodel.constants.ts`, the set a model version's `baseModel` is validated against); 400 without it or for any other value, since it is the only caller-chosen term of this mode's cache key. A new base model is admitted once its record ships in that constant. The add-on path does not validate `baseModel` this way. `prompt` is still required, as in add-on mode, though neither arm ranks by it. The block route admits it only behind `resourceIntentCheckpoint` (fliptKey `resource-intent-checkpoint`, dark, read only behind `resourceIntentJev`); with that flag off the route answers 400 rather than serving add-ons to a caller that asked for checkpoints. An absent `kind` (or `'addon'`) is the add-on path above, unchanged: its response, cache key and shadow row are exactly what they were.

- **No stage 1, no stage 3, no vendor call.** `intent`, `criteria` and `noneProbability` are `null`; `model` is `'none'` on an undegraded response. Neither arm reads the prompt, so the prompt is not in the cache key (its hash and length are still on the shadow row).
- **ATTACH_BM (served).** The checkpoint models attached most often in the snapshot's training images, counted within the request's baseModel (one count per image per distinct (baseModel, model), by the attached version's baseModel); the top 300 by count, ties by ascending id, go through the matcher's checkpoint gate for that baseModel (`id IN`, unsorted, re-sorted by count rank, one version per model), first `min(limit, 50)`. A list shorter than 50 is served as it is, not filled, because that is the list the checkpoint screen measured; an ecosystem with no attachments in the snapshot gets an empty list.
- **BASE_BM (the study's comparator).** Thumbs-up popularity within the baseModel: the matcher's 500-document popularity page under the checkpoint gate, one version per model, first `min(limit, 50)`. Selected only through the service context (`checkpointArm: 'base_bm'`); the route never sends it. It reads no snapshot.
- **Snapshot.** The counts are a section of the co-occurrence snapshot, built from the same draw (`checkpoint-attach.ts`) as an optional 12th payload element; the section has its own `CHECKPOINT_ATTACH_BUILD_HASH` and is outside `RESOURCE_INTENT_COOC_SPEC_HASH`, so it did not invalidate any existing snapshot for POOL_MERGE. A snapshot without the section (every snapshot built while the writer flag below is off) makes checkpoint mode serve BASE_BM's list with `coocFallback: true`, reason `spec_mismatch`. The same applies after any change to the section's build hash. A section that does not decode is ignored the same way (logged as `resource-intent-checkpoint-section-invalid`); it never takes the snapshot away from POOL_MERGE. Other fallback reasons are the holder's (`no_snapshot`, `load_failed`, `snapshot_unservable`, `loading`); the fallback caches for 60 s, as POOL_MERGE's does.
- 🔴 **Writing the section is behind its own flag, and turning it on is a one-way door for rollbacks.** Decoders from before this change accept exactly 11 payload elements and refuse a payload carrying the section; a pod running one would find such a snapshot unservable (POOL_MERGE `snapshot_unservable`). So the build (the weekly `build-resource-intent-cooc` job and `scripts/build-resource-intent-cooc.ts` alike) writes the section only while the Flipt flag `resource-intent-cooc-checkpoint-section` (`FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_COOC_CHECKPOINT_SECTION`, default off; unknown or unreachable reads as off) is on. Off, the payload is byte-for-byte the 11-element one older decoders read. **Turn it on only after the release carrying this reader has fully rolled out and its rollback window has passed**, then run a production build by hand (or let the weekly job, while its own flag is on, run one); that build is how checkpoint mode gets its section. The script has no switch of its own, so a hand build cannot write the section while the flag is off; its summary prints `checkpointSection`. The decoder now ignores payload elements after the ones it knows, so a later section does not repeat this hazard for pods running this code.
- **Study mode.** `ctx.coocSnapshotId` serves ATTACH_BM from that pinned study snapshot's section and fails closed (`degraded: true`, no search, no cache) if the snapshot cannot be served or has no servable section.
- **Cache key.** `checkpoint`, the arm, baseModel, browsing level, `min(limit, 50)`, the coverage audience (resolved before the cache read in this mode), and on ATTACH_BM the snapshot hash (`fallback` when none), `RESOURCE_INTENT_COOC_SPEC_HASH` and `CHECKPOINT_ATTACH_BUILD_HASH`; always `RESOURCE_INTENT_CHECKPOINT_SPEC_HASH` last.
- **Shadow.** Checkpoint rows send the pool-merge columns (`arm` = `attach_bm` / `base_bm`) plus `kind` and `checkpointSpecHash`, which need `src/server/clickhouse/migrations/2026-10-11-resource-intent-shadow-checkpoint.sql` (after the pool-merge one), applied by hand before `resourceIntentCheckpoint` opens anywhere. `specHash` and `stage3SpecHash` are blank and `specVersion` is 0 on these rows. ⚠️ The M4 volume query counts every row; filter it with `kind = 'addon'` once checkpoint rows exist.
- **Degrade.** A search or hydration failure returns `degraded: true` with empty suggestions and `model: 'checkpoint-unavailable'` (not the add-on path's `'jev-unavailable'`: no vendor is involved), reason `checkpoint_error`, cached 60 s. A study fail-closed reports the same `model`.
- **No single-flight.** With no prompt in the key, one entry serves every request for an ecosystem, so concurrent misses on a cold or just-expired key each run the search (up to a 300-id or a 500-document page) and hydration; no vendor call. Likewise each distinct known `baseModel` — even one no checkpoint carries — costs one such search on BASE_BM (or the ATTACH_BM fallback) and an hour-long entry; the known set bounds how many such keys there are. Revisit both once the flag opens, against the per-ecosystem request rate.
- **Rate limit.** The same per-instance LLM bucket as add-on requests, although this mode makes no vendor call; kept while the mode is dark.

## v1 content tags (dark)

A third add-on arm, `v1_tags`: the prompt's literal phrases from a frozen vocabulary, scored against a per-resource content-tag index. Its foundations are below; how the request path serves and shadows it is [The v1_tags arm](#the-v1_tags-arm).

- **Extractor** (`resource-intent-tags/extract.ts`). A port of the offline prototype's normaliser and literal matcher: NFKC and lowercase; `<...>` tags, `embedding:` names, brackets, separators and `BREAK` split segments; `:1.2`-style weights are removed and `_` becomes a space; tokens trimmed of quotes and hyphens, all-digit tokens dropped; hyphens removed and plurals singularised for the key. A segment of up to 4 tokens is one key unless every token is a stopword; a longer one contributes its stopword-free 1–3-grams. `matchVocabularyKeys` returns the vocabulary keys found in a prompt, in code-point order. Python's Unicode-aware `\w`, `\s`, `\b`, `isdigit()` and `len()` are spelled out explicitly, because JavaScript's defaults differ.
- **Grouping and weights** (`resource-intent-tags/groups.ts`). Synonyms are grouped per request, over every vocabulary tag FOUND in the prompt before the explicit gate: by descending idf (ties by key, code-point order), each tag joins the first group whose head's `near` set holds it. A kept tag's weight is its group head's idf divided by that pre-gate group's size; the gate removes tags and never re-splits a weight, so a gated head still holds its survivors together. `src/server/services/__tests__/resource-intent-tags.groups.test.ts` holds it to the vocabulary miner's golden fixture.
- **Scorer** (`resource-intent-tags/score.ts`). Pure functions over an in-memory index (the typed `TagIndex`, which the snapshot decoder fills): the explicit gate, `matureAllowed` = the token-clamped browsing level includes R, X or XXX (the per-tag `explicit` flag is the only input; the rule that sets it is not in this repository); the tag-derived ecosystem when the caller gave no `baseModel` (the top 3 by Σ w·ln lift, Dirichlet-smoothed with m = 50, over ecosystems with at least 100 training users and, on the request path, at least 300 of the kind's resources published under the ecosystem's gate (`gateEligibleEcosystems` in `resource-intent-tags/gate.ts`; the floor is the candidate width, so an ecosystem with next to no add-ons, such as an API-only one, cannot win on tag lift and list next to nothing); the lift's observation totals still count every ecosystem, so the index must carry those below the floor too); and the registered V1 score `S = M·exp(F) + 0.05·U + 0.02·P` over the ecosystem's resources with `M > 0` or `U > 0`, ranked by score then model id, first 300, which the request path then puts through the matcher's gates (`findRankedCandidates`). Nothing is ranked, and the status says why, when no tag passes the gate (`no_tags`), no ecosystem has enough training users and resources under its gate (`no_ecosystem`), or the ecosystem is not in the index (`unknown_ecosystem`). The vocabulary miner writes idf rounded to 6 decimals; the prototype used it unrounded, so two very common tags whose idf rounds equal can order (and head a group) by key instead. `resource-intent-tags.score.parity.test.ts` holds it to the offline prototype's own output on a synthetic index.
- **Build** (`resource-intent-tags/build.ts`). Pure: from the frozen vocabulary row (`parseTagVocabulary`: schema `p2m-vocab/2`, version = sha256 of the payload bytes), model content and training rows, it applies the prototype's index computation to them (`resource-intent-tags.build.parity.test.ts` holds that computation to the prototype's own output; the inputs differ from the prototype's as the Inputs bullet lists). Content tags per resource by noisy-OR, `c = 1 − Π_s (1 − w_s·f_s)`, with source weights showcase 1.0, gallery 0.6, Civitai tags 0.8, trigger words 0.5, name 0.8, description 0.3 (HTML stripped); a prompt source's `f` is the share of its prompts carrying the tag, `k / (n + 3)`, used only with at least 3 showcase and gallery prompts; kept at `c ≥ 0.1`, rounded half to even to 4 decimals. Outcomes per row against the user's own shrunk baseline (generator: liked/favourite +1, disliked −1; posted: `tanh` of log1p(reactions) against the poster's baseline, scaled by the posted rows' standard deviation, plus 1 when tipped); one vote per user per (resource, key); the resource fit shrunk to 0 (prior 20), the (resource, tag) fit shrunk to the resource fit (prior 10) for pairs with at least 2 users; the user-side shares `s = rel·lift^0.5·exp(fit)` normalised per tag and per ecosystem; popularity as users per (resource, ecosystem); training users and rows per ecosystem and raw (tag, ecosystem) row counts over every ecosystem a row or a model names. A row's ecosystem is the base model of its checkpoints when they agree on exactly one. A generator row the platform's regex prompt audit (`auditPrompt`, which includes the POI check) or minor check rejects is dropped before tagging (`prompt-exclusion.ts`, fail-closed); posted rows are not audited, being moderated images. `resource-intent-tags.build.parity.test.ts` holds every one of these to the prototype's own output on synthetic raw inputs, and scores through the encoded snapshot against the prototype's ranking.
- **Snapshot** (`resource-intent-tags/payload.ts`). msgpack + brotli with the vocabulary embedded, its version and the spec hash in the header. Lossless against the build except for float32 values (idf stays float64 and the vocabulary, ecosystem and (tag, ecosystem) counts stay exact integers; every other decoded value, content scores and popularity counts included, is float32, and decoded scores match the float64 build to 1e-7 on the parity fixtures): content scores travel as exact integers c·10⁴, ascending ids as deltas, CSR pointers as row lengths, pair fits only where a pair has one (under a presence bitmap), and multi-byte arrays byte-plane shuffled so brotli can compress them. `tagIndexFromData` fills the scorer's `TagIndex` from built or decoded arrays and refuses any that break the scorer's preconditions: model ids strictly ascending, every CSR pointer of the right length and monotone, ids in range and ascending, values finite, fits within ±`tagFitBound()` (2 at the current outcome scale: a fit is a shrunk average of outcomes that lie in [−2, 2], and a fit feeds `exp()` in the score), content scores in [0, 1], and the ecosystems' observations summing to the build's count of rows with an ecosystem (so none, including those below the resolver's floor, was dropped). Payloads above 256 MiB are refused both ways, and inflating above 1 GiB. With every eligible model indexed (**Inputs** below) the real index measured 146 MiB compressed (374 MiB of msgpack before brotli) in an October 2026 dry run, against 80.4 and 183 MiB when only the models seen in training rows were. The caps leave room for growth: the eligible set grew by about 4,300 models a week over the twelve months to September 2026 (a third of today's set a year), so a payload growing with it reaches 256 MiB in about two years, and a payload at the cap would inflate to about 655 MiB at the measured ratio. It is stored in object storage with a manifest row (**Snapshot store** below), not in a Postgres column. The full-coverage dry run measured the decoded index at 777 MiB per process (629 MiB of arrays plus 149 MiB of heap; 669 MiB of RSS) after 0.88 s of decompression (off the event loop), 0.72 s of unpacking and 0.41 s of validating and assembling, which is why the holder decodes on a worker thread (**Holder** below). msgpackr keeps a view of the last buffer it unpacked until its next unpack, so the decoder unpacks a one-byte nil after every snapshot; a decode measured without that holds the whole inflated snapshot too. The encoder writes the msgpack itself, byte for byte what msgpackr wrote (`resource-intent-tags.pack-writer.test.ts` holds the two to each other across every header-size boundary), so it can stream: `encodeTagIndexCooperative` packs straight into brotli as the bytes are produced, pausing for the event loop, and with `consume` empties the built postings as it goes, so a build never holds the index, its packed bytes and its payload at once. Brotli's output does not depend on where the writes break, so its bytes are `encodeTagIndex`'s.
- **Inputs** (`resource-intent-tags/sources.ts`). The prototype's sample: posted images with `id % 6 = 0` over 90 days with the co-occurrence builder's eligibility, read from a standby in id-bounded batches, each statement in a READ ONLY transaction that refuses a server that is not a standby; generator observations from ClickHouse (not written by this repository) in each hour's first 2 minutes, deleted accounts excluded; model content (newest 4 versions' showcase and gallery prompts, tags, trigger words, name, description). Posted user ids are hashed with the observations' key so both sources count a person once, and a key whose fingerprint differs from the one the observations were written under is refused (the dry run takes the expected fingerprint from its environment and prints how many users the two sources share). The content-image predicate is the co-occurrence index's own image and attachment conditions (`COOC_ELIGIBLE_IMAGE` + `COOC_ELIGIBLE_ATTACHMENTS`). Unlike the prototype, nothing reaches the index from a model flagged POI or minor (a generator row or a content image using one is dropped, as such a posted image already is) or from a Private or Unsearchable post, and a generator row takes its ecosystem from its checkpoint versions' baseModel rather than the workflow resource's own baseModel, which the observation table does not store. Content is read for every eligible model (`readEligibleModelIds`: published, listed, not POI or minor, of an add-on type or Checkpoint, with a published version; 659,175 in October 2026) and for any listed model seen in training rows, three 1,000-model batches at a time and handed on in id order. The prototype indexed only used models; a model no sampled row used is now indexed on its content tags alone, its resource fit the shrinkage prior's 0 and with no user-side share, so it ranks on `M·exp(0)`. Listed (`MODEL_LISTED_SQL`) means Published (a status; Private is an availability), not Private, and not Archived or TakenDown, and every read that admits a model applies it: eligibility, the resources of generator and posted rows, and model content. A model a sampled row used that is not listed (deleted, unpublished, a draft, Private, Archived or TakenDown) is kept out like an unused one: it is dropped from the row's resources, and the row stays if any listed resource is left. The row's ecosystem still comes from every checkpoint it used, listed or not, since it is a property of what was generated (`ecosystemResources`). Among published models, Private, Archived and TakenDown left out 3,370 otherwise eligible ones in October 2026 (2,201, 1,158 and 11). The arm's other resource gates (maturity, region and so on) are not applied at build time; the request path applies them (`findRankedCandidates`, [The v1_tags arm](#the-v1_tags-arm)). Every standby statement runs with `jit = off`: JIT compilation made the content-image and posted-sample statements several times slower (alternating on and off on the same statement, warm: 3.9–4.0 s against 0.6 s, and 3.9 s against 1.0 s). `scripts/dry-run-resource-intent-tags-build.ts` runs the build job's pipeline as a dry run (gates included, nothing stored) and prints sizes, timings, peak RSS and wall time.
- **Spec hash** (`resource-intent-tags/spec.ts`). `RESOURCE_INTENT_TAGS_SPEC_HASH` fingerprints the extractor's output on fixed synthetic prompts, the packed snapshot of a build over a small fixture, the scorer's output on a fixed synthetic index, and the extractor's, build's, sources' and scorer's constants (not the sources' SQL), the snapshot format and the mature levels, so a change those fixtures exercise moves it (the parity fixtures cover the rest). The tests pin it as a literal.
- **Vocabulary table** (migration `20261029120000_resource_intent_tags`, applied by hand). `ResourceIntentVocabulary` holds mined vocabularies. `vocabVersion` is UNIQUE and is the sha256 of `payload` (a CHECK). `status` is `candidate` (the default), `frozen` or `retired`; a CHECK requires `frozenAt` and `frozenBy` both null on a candidate, both set on a frozen row, and both or neither on a retired one. Nothing in the database orders status changes, so a mistaken retire can be undone. Its payload format is `p2m-vocab/2`, parsed and validated by `parseTagVocabulary` (`resource-intent-tags/build.ts`).
- **Snapshot store** (`resource-intent-tags/store.ts`, `resource-intent-tags/objects.ts`; migration `20261103120000_resource_intent_tag_index_snapshot`, applied by hand after the vocabulary migration, then `20261106120000_resource_intent_tag_index_snapshot_payload_cap`, which raises its `payloadBytes` CHECK to 256 MiB to match the code's cap; apply it before the build flag is on with this code, or every production build refuses before reading anything (**Build job** below)). The payload is an object in `RESOURCE_INTENT_TAG_INDEX_BUCKET` at `resource-intent/tag-index/<sha256 of the payload>` (a fixed prefix). The bucket is a dedicated private bucket in Backblaze B2, written and read through its own client built from `RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT`, `RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY` and `RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY` (a bucket-scoped key; path-style requests; `RESOURCE_INTENT_TAG_INDEX_B2_REGION`, default `us-west-004`), never the `S3_UPLOAD_*` credentials: with any of those three unset or empty the store refuses, naming every missing one, and nothing falls back to another client. Because the prefix is fixed, the bucket alone separates environments: each environment needs its own private bucket, never fronted by a CDN, since the payload carries the whole vocabulary. With the bucket unset or empty the store refuses, and it refuses a bucket that is any other bucket the app is configured with (`S3_UPLOAD_BUCKET`, the image, vault, B2, appeal, scan-label and bundle buckets). `ResourceIntentTagIndexSnapshot` holds one manifest row per stored snapshot: `vocabVersion` (a foreign key, so a vocabulary a snapshot names cannot be deleted), `specHash`, `payloadSha256`, `payloadBytes`, `objectKey`, the build's stats, `createdAt` (the database's clock) and `status`. `status` is `ready` or `retired`. There is no `building` state: the writer uploads first and inserts second, so a row is born ready and an unfinished build leaves no row. Retiring is one-way. A trigger refuses a row whose vocabulary is not frozen when it is inserted, reading the vocabulary row `FOR SHARE` so a concurrent un-freeze waits for the insert, or the insert for it, and refuses every change to a row other than retiring it. A second trigger, on `ResourceIntentVocabulary`, refuses moving a vocabulary a ready snapshot names back to `candidate` (retire the snapshot first); retiring the vocabulary stays allowed. A two-connection test on PostgreSQL 16 showed each of the two is needed: without either, an un-freeze and an insert racing each other both commit.
  - `putSnapshot` refuses a vocabulary that is missing or not `frozen`, and a payload that is empty, over 256 MiB, does not decode, or whose header's spec hash or vocabulary version is not the one it is stored under. Then it uploads, then inserts. The same bytes again return the standing row. **If the insert fails after the upload**, it throws `TagIndexManifestInsertError` naming the key and leaves the object: no row names it, so nothing loads it, and putting the same payload again writes the same key and inserts. It never deletes the object, because a ready row may already name that key. Nothing else deletes it either: retention deletes only objects its own retired rows name (**Retention** below). Such an orphan is a leak of one object, rare (a build killed between the upload and the insert), and a later put of the same bytes reuses its key.
  - `loadLatestSnapshot(specHash)` reads the newest ready row built under that spec hash (`null` when there is none). It streams the object into one buffer of the manifest's size, hashing as it goes. It refuses, each with its own `TagIndexSnapshotUnservableError` subclass: a vocabulary that is a candidate; an object that is gone; bytes whose length or sha256 is not the row's (an object reporting another size, running past it or ending short), checked before decoding; bytes that do not decode; a header whose spec hash or vocabulary version is not the row's. A snapshot whose vocabulary was retired after its build is still served. Any other download failure, or running out of memory while decoding, is rethrown as it is. It does not fall back to an older row: retiring the newest row is how an operator returns to the previous one.
- **Build job** (`src/server/jobs/build-resource-intent-tag-index.ts`, `resource-intent-tags/pipeline.ts`). `build-resource-intent-tag-index` runs Tuesdays at 06:00 UTC, an hour after the co-occurrence build, behind the default-off Flipt flag `resource-intent-tag-index-build`, with a 120-minute lock (`LOCK_MINUTES`, about three times the full-coverage dry run). Before it reads any training data it refuses, in this order: any of `RESOURCE_INTENT_TAG_INDEX_BUCKET`, `RESOURCE_INTENT_TAG_INDEX_B2_ENDPOINT`, `RESOURCE_INTENT_TAG_INDEX_B2_ACCESS_KEY`, `RESOURCE_INTENT_TAG_INDEX_B2_SECRET_KEY` (a dry run stores nothing and needs none of these four), `P2M_CLICKHOUSE_URL`, `P2M_CLICKHOUSE_USER`, `P2M_CLICKHOUSE_PASSWORD`, `P2M_HASH_KEY` or `P2M_HASH_KEY_FINGERPRINT` unset or empty (one error naming them all); a hash key that is not hex or not the observations' (`assertObservationKey`); a snapshot bucket that is another of the app's buckets (the store's own check); a snapshot table whose `payloadBytes` CHECK admits less than the code's cap (`assertSnapshotTableAdmits`: migration `20261106120000_resource_intent_tag_index_snapshot_payload_cap` not applied; `putSnapshot` also refuses, before uploading, any payload over the bound the CHECK holds); a ClickHouse account whose own profile is not `readonly = 2` (the client sends no `readonly`, so the check reads the account's level: at 0 the account could write; an account at 1 never reaches the check, because it refuses the settings the build sends and its first query fails with ClickHouse Code 164); no generator observation at or after the training window's end (the observations' only writer is an external hourly extractor, so a missing tail means it has not covered the window); more than 2% of the hours whose sample slice (each UTC hour's first minutes, the same `genSliceCondition` predicate the generator read uses) holds no observation (the slice only: the read also drops observations by deleted accounts and those whose prompt has no stored text, and the gate counts those, so an hour can pass while the build reads nothing from it), counted by UTC hour from the later of the window's start and `TAG_OBSERVATION_FLOOR` to the window's end; and no frozen vocabulary. The end check deliberately ignores the slice: it only asks whether the extractor has written past the window, which any row shows, while the hours inside the window are the slice-aware check's. The floor is 2026-09-13T00:00Z, the first hour whose slice holds rows: the extractor's 31-day backfill starts at 2026-09-12 23:20, past that hour's slice. It is pinned rather than read as the table's oldest row, so a later truncation or re-backfill cannot quietly shrink the checked span, and it has no effect once the window starts after it, from about 2026-12-14. A production build whose generator read then returns no observations at all is refused too. Until then a snapshot trains on a shorter generator span than 90 days, and says so: the summary and the manifest row's build stats record `observationHours` (the start coverage was counted from, the hours to the window's end, and how many were missing). A dry run reports missing hours instead of refusing. In October 2026 coverage counted from the floor was 791 of 792 hours (one hour held rows, but none in its slice). It builds from the newest frozen vocabulary by `frozenAt`, puts a production snapshot, and returns aggregates only: counts, phase timings, the window, the vocabulary version, and the manifest row's id with whether this run created it. Generator prompts are audited with `privateInput`, so a slow audit's log line carries timings and the prompt's shape but no text and no hash, whatever `AUDIT_SLOW_LOG_RAW` says. Generator observations are read one UTC day per query, each response read to its end before its rows are tagged: ClickHouse aborts a response its client stops reading for its send timeout (30 s by default), and neither a per-query nor a per-profile `http_send_timeout` changed that in a test against ClickHouse 26.7. Tagging yields to the event loop every 50 ms, and so does the final index computation (`finalizeCooperative`, the same output as `finalize` byte for byte): on a synthetic index of the real size, the longest stall fell from 9.5 s to 0.16 s. So does the encode (`encodeTagIndexCooperative`, **Snapshot** above). The decode inside `putSnapshot` validates without assembling the scorer's maps, which it does not need, and lets the event loop turn between unpacking and validating. The accumulator and every training-side structure are unreachable before the put decodes. In the October 2026 full-coverage dry run the build took 38 minutes (generator 5.9, posted 13.4, eligible ids 0.4, content 17.7, finalize and encode 0.6) and its process peaked 2.32 GiB above where it started, the put's decode included (2.07 GiB without it); before this change, at the old coverage, the same dry run took 44 minutes and the build peaked 2.56 GiB above its start, and a decode of its payload afterwards stayed below that. The longest event-loop stall was 0.28 s in the build and 0.83 s in the put's decode (its unpack; if that grows with the payload, at about a third more models a year it passes 1 s in about seven months, and moving the put's check onto the decode worker would remove it). Holding three times the models in less: the accumulator keeps models in flat arrays by first appearance (no object per model), content tags in one run per model with scores as exact integers c·10⁴, and drops the rows and the content as soon as the index no longer needs them; the postings are built resource by resource straight into their final arrays, as float32 in the pipeline (`float32Postings`: the snapshot's own precision, so the same bytes); and the encoder streams (**Snapshot**). Its Postgres reads go to a standby, each statement capped at `COOC_STATEMENT_TIMEOUT_MS`, though the replica route a deployed job uses may cancel one sooner; the dry run prints every statement kind's slowest attempt, so check it against that route's limit after a change to the reads. The put writes through `dbWrite`, whose role must own the tables or hold `UPDATE ("vocabVersion")` on `ResourceIntentVocabulary` besides `SELECT` (the snapshot trigger's `FOR SHARE` read needs it; otherwise every put fails after its upload; the migration header has the grant). Its heartbeats and retention are under **Heartbeats, metrics and alerts** and **Retention** below. Coverage is the Inputs bullet's: every eligible model.
- **Holder** (`resource-intent-tags/holder.ts`, `decode-worker.ts`). `tagIndexSnapshotHolder().resolve()` is the accessor the request path calls ([The v1_tags arm](#the-v1_tags-arm)). 🔴 **It loads nothing unless the default-off Flipt flag `resource-intent-tag-index-holder` is on**: off, unknown or unreachable, `resolve()` answers `disabled` without a database read, a download, or importing the spec-hash or decode-worker modules, and it drops a snapshot already held. On, it serves the newest ready snapshot built under this code's spec hash, checked when asked at most every 5–6 minutes (jittered per pod), loaded once per change and shared by concurrent callers; with nothing held, requests arriving in a load's first 10 s wait for it, later ones get the fallback at once; a check running past 2 minutes is aborted (its download and decode worker stop, and it stops waiting on a database read), and no new check starts until it has settled, so loads do not overlap. The held index is replaced only once the new one has downloaded, verified and validated; a failed load keeps it. A snapshot refused as unservable (missing object, wrong size or sha256, bytes that do not decode, a header or vocabulary that does not match) is not downloaded again while its row stays ready, newest or not, and the newest ready row no refusal names is served instead; any other failure (database, network, a decode worker that did not answer, running out of memory) is retried 60 s later. That includes a pod without the snapshot bucket or its credentials (**Snapshot store**): with a ready row to load, its store refuses before any download, so the pod answers `load_failed`, logs `…-load-failed` and retries every 60 s until the variables are set (with no ready row it answers `no_snapshot` and never builds a store). Fallback reasons: `disabled`, `no_snapshot`, `load_failed`, `snapshot_unservable`, `loading`. Retiring the served row makes every pod serve the previous ready row at its next check. Each load is logged with its time (`resource-intent-tag-index-loaded`, or `…-load-failed` with its reason). 🔴 **The holder asks only for snapshots built under its own spec hash**, so it has no `spec_mismatch`: after a release that moves `RESOURCE_INTENT_TAGS_SPEC_HASH`, every pod answers `no_snapshot` until a build under the new hash lands, which on the weekly schedule can be a week. Run a production build by hand after such a release (trigger the `build-resource-intent-tag-index` job, which runs only with `resource-intent-tag-index-build` on), before anything serves from the holder; until a pod holds a snapshot, nothing it exports shows its spec hash. **Off the main thread:** the object is streamed and hashed on the event loop chunk by chunk, then handed (transferred, not copied) to a worker thread that decompresses, unpacks and validates it and hands the arrays back transferred; the main thread only builds the scorer's maps, cooperatively. The worker runs from a string (`decode-worker.source.generated.ts`, bundled from `decode-worker.entry.ts` and the decoder module `payload-decode.ts` by `scripts/build-tag-index-decode-worker.mjs`), because the standalone image ships only traced files and a spawned worker file is the failure class `next.config.mjs` records. The bundle requires only Node builtins and holds the decoder alone (msgpack's unpacker only, and nothing from `build.ts`, which the generator refuses): every limit the decode enforces, the size caps and the fit bound, is handed to the worker by the main thread, so a tuning change cannot leave the worker disagreeing with the code that spawned it. What the bundle still embeds are wire-format constants (the format id, the content-score scale c·10⁴), which change only with the payload format, and the vocabulary key order (`compareCodePoints`), which is code. A stale bundle fails a unit test and the `packages` CI job's `--check` step. That step shows red but does not block a merge: `main` has no required status checks. Measured on synthetic payloads at two sizes: today's (151,812 + 3,649 models, about 18M postings; 108 MiB compressed, 208 MiB unpacked) and full coverage (the operator's decision to index every eligible model: 607,248 + 14,596 models, about 43M postings, unused models with content postings only; 183 MiB compressed, 365 MiB unpacked). Synthetic data compresses worse than real (the real index measured 80.4 MiB at the old coverage and 146 MiB at full coverage, against 108 and 183 MiB synthetic), so the compressed sizes overstate. The longest event-loop block during a load fell from 710–714 ms (decoding on the main thread) to 43–51 ms at today's size, and from 1,163–1,235 ms to 59–61 ms at full coverage; most of what remains is the structured-clone of the reply's vocabulary. Memory: with the flag off the holder adds nothing (1,000 `resolve()` calls: no read, download or decode; heap and external +0 MiB, RSS +0.2 MiB of noise). With it on, the held index was 76 MiB of heap and 282 MiB of external arrays at today's size (612 MiB of RSS just after the first load, which includes freed load buffers the allocator had not returned), and 120 MiB of heap and 574 MiB of arrays at full coverage (1,173 MiB of RSS after the first load). The real full-coverage index measured 629 MiB of arrays and 149 MiB of heap decoded (`scripts/dry-run-resource-intent-tags-build.ts`, October 2026), about an eighth more than its synthetic stand-in. While a new snapshot loads, the old one is still held, so a reload briefly needs both: reloading while holding one peaked about 650 MiB of RSS above the held state at today's size and about 1.15 GiB at full coverage (1.2 and 2.3 GiB above the process before any load). After a build every flag-on pod that is being asked for the index reloads within the 5–6 minute poll, so size pods for that peak. The worker enforces `TAG_INDEX_DECODE_CAPS` (the exported payload and inflate caps) and `tagFitBound()` as the main thread hands them. Each pod that is asked for the index downloads the whole snapshot on its first request after every deploy and after every weekly build, 146 MiB at full coverage, so each such event costs that times the number of pods serving the route in bucket egress; keep those pods few.
- **Heartbeats, metrics and alerts.** The job records its build's last success and retention's last success in `KeyValue` (`job:build-resource-intent-tag-index:last-success`, `job:resource-intent-tag-index-retention:last-success`; epoch ms), exported by every pod's `/api/metrics` as `civitai_app_resource_intent_tag_index_build_last_success_timestamp_seconds` and `…_retention_last_success_timestamp_seconds` (label `job`). A failed run records nothing: a stale success is the signal. `civitai_app_resource_intent_tag_index_newest_ready_created_timestamp_seconds{spec_hash}` is the newest ready row's `createdAt` per spec hash (12-hex prefix). Both database reads behind these gauges run only while the build flag is on, so a pod with every flag off does no I/O for them (unlike the co-occurrence retention heartbeat, whose job is ungated). Per pod, the holder exports `civitai_app_resource_intent_tag_index_loads_total{outcome}` (`success`, `load_failed`, `snapshot_unservable`; seeded at 0), `…_load_duration_seconds{outcome}`, and, only while it holds one, `…_snapshot_age_seconds{snapshot_id}` and `…_snapshot_info{snapshot_id,payload_sha256,spec_hash,vocab_version}`. This repository holds no alert rules; the staleness alerts (no ready snapshot newer than 8 days, which also catches a build lost with its pod; build and retention heartbeats older than 8 days) belong with the infrastructure's rules and should be armed when the build flag opens. While the build flag is off, all three series (build success, retention success, newest ready) are absent, not frozen, and the heartbeats are also absent until their first write, so each staleness alert needs an `absent()` (or `absent_over_time()`) clause beside its age threshold, or a missing series will never fire it.
- **Retention** (`resource-intent-tags/retention.ts`). Run by the weekly job after every build attempt (snapshots change only when the job runs). Rows are retired through the table's one-way trigger, never deleted: under the running spec hash all but the newest 3 ready rows (the served one and two to fall back to, about 146 MiB each at full coverage); under any other spec hash all but the newest, and that one too once older than 28 days (a release rolled back past a spec change serves it). Then it deletes each object that this database's retired rows name and none of its ready rows does (read after retiring, so a put of identical bytes, which reuses the key, protects its object), provided the key is a snapshot key under the store's prefix; the store's `delete` refuses any other key too. Nothing is listed, so nothing outside this database's own retired rows is touched. That does not make a shared bucket safe: the payload depends only on the input data and the build day, so two environments can produce the same key, and one's retention could delete an object the other serves; each environment needs its own bucket (**Snapshot store**). The cost of not listing is the orphan the **Snapshot store** bullet describes, left in place. One key's failed delete does not stop the others; any failure then fails the sweep, naming the keys, so its heartbeat goes stale. A key deleted by an earlier run is deleted again. B2 keeps versions: a delete through its S3 API hides the file rather than removing its bytes, so the bucket needs a lifecycle rule that purges hidden versions, or retired snapshots keep costing storage. On the snapshot bucket, the serving pods' key needs `listBuckets`, `listFiles` and `readFiles` (the holder's download), and the job's key needs those and `writeFiles` (the put) and `deleteFiles` (retention); the build itself never reads an object back (`putSnapshot` validates the payload in memory before uploading it), and nothing lists the bucket. The list capabilities are there for the missing-object case: measured against B2, a get of a never-written key with a key holding `listFiles` and `readFiles` but not `listBuckets` answered `AccessDenied`, and `NoSuchKey` once `listBuckets` was added (a hidden key answered `NoSuchKey` either way). Only `NoSuchKey` is refused as a missing object; `AccessDenied` is any other failure, so the holder would retry that snapshot every minute instead of refusing it as unservable. A retention failure does not fail the job: it is returned in the job's result when the build succeeded, logged when the sweep itself throws, and its heartbeat goes stale either way.
- **Build residency (operator decision, October 2026):** the build stays on the shared jobs pool, where at full coverage it adds about 2.3 GiB of RSS to its process at its peak (the put's decode; before the memory work, at the old coverage, the peak was 2.6 GiB, the build's own) and yields the event loop only in slices.

## The v1_tags arm

Three default-off Flipt flags, each read only behind `resourceIntentJev`:

| flag (fliptKey)                                                | effect                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resourceIntentV1` (`resource-intent-v1`)                      | Add-on requests are served by `v1_tags`, over `resourceIntentPoolMerge`. Study mode (`ctx.coocSnapshotId`) ignores it. Checkpoint mode is untouched.        |
| `resourceIntentV1Shadow` (`resource-intent-v1-shadow`)         | Every request served by another arm, checkpoint mode included, also computes the `v1_tags` list after its response is built, and records it on its own row. |
| `resourceIntentJudgeCapture` (`resource-intent-judge-capture`) | Add-on prompts are recorded for the judged comparison of the two arms.                                                                                      |

The arm reads the tag index only through the holder, so with `resource-intent-tag-index-holder` off every v1 request falls back (`disabled`). There is no flag that serves `v1_tags` for checkpoints.

**Served (add-on).** The holder is resolved before the cache read, because the held snapshot is a key term. On a miss:

1. Stage 1 runs as on the other arms: one vendor call, and `intent` and `criteria` are filled as today. It is kept because callers read `criteria.role` to tell why a list is empty. The arm is role-free: a stage-1 `none` does not empty its list, and `noneProbability` is stage 1's.
2. The prompt's literal vocabulary tags go through the explicit gate at the token-clamped browsing level and are scored (**Scorer** above). No vendor call is made for tags. The ecosystem is the caller's `baseModel`, else the top tag-derived one.
3. The ranked candidates (at most 300) go through `findRankedCandidates`: the matcher's own filter for the add-on types and that ecosystem, AND `id IN candidates`. The ecosystem, the caller's `baseModel` or a tag-derived one alike, gates, per add-on type, by every base model whose resources generate on it fully or partially (`ecosystemBaseModelGate`, the generation form picker's `getCompatibleBaseModels`), because its candidates are mostly published under a sibling's name: a distilled variant's under its base model (`Krea 2 Turbo` under `Krea 2`, `SDXL Lightning` under `SDXL 1.0`), a fine-tune family's under a sibling family's that a cross-ecosystem rule admits (`NoobAI` under `Illustrious`). With an exact name, an add-on request on such an ecosystem can leave top-10 slots empty; an offline judged evaluation of add-on requests that pass a `baseModel` found many such empty slots, and scored the compatible gate higher. Within this list, only the v1 checkpoint shadow keeps a caller's `baseModel` as its exact name (`v1ListBaseModelFilter`); a fallback list is POOL_MERGE's, which does too. The hits are re-sorted by rank, one version per model, first `min(limit, 50)`. Then hydration re-checks access and the maturity ceiling, as on every arm. The index admits only listed models when it is built; these gates are what hold at request time.

The response carries `arm: 'v1_tags'` and `v1Fallback`, plus `ecosystems` (the top tag-derived ecosystems, best first) when the caller gave no `baseModel` and the list is v1's own. All three are optional in `resourceIntentResponseSchema` and appear only on v1 responses. A required field would make every cached blob from an older build fail to parse, and strictness makes older pods refuse newer blobs; optional fields written only under v1 keys avoid both. Flip `resourceIntentV1` only once the release carrying the arm is on every pod.

**Failure ladder.** A fallback is not a degrade: the response is the POOL_MERGE arm's list for the same stage-1 answer (co-occurrence snapshot, `coocFallback` and role `none` emptying included), with `v1Fallback: true`, cached for 60 s.

| condition                                                                                         | `v1FallbackReason`                                                                              | served                                   |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------- |
| no servable tag index                                                                             | the holder's reason: `disabled`, `no_snapshot`, `loading`, `load_failed`, `snapshot_unservable` | the POOL_MERGE list                      |
| no tag passes the explicit gate (none in the prompt, or every one explicit at a non-mature level) | `no_tags`                                                                                       | the POOL_MERGE list                      |
| no `baseModel`, and no ecosystem has enough training users and resources under its gate          | `no_ecosystem`                                                                                  | the POOL_MERGE list                      |
| the ecosystem is not in the index (a `baseModel` the index never saw)                             | `unknown_ecosystem`                                                                             | the POOL_MERGE list                      |
| nothing ranked survives the gates and hydration                                                   | `no_candidates`                                                                                 | the POOL_MERGE list                      |
| stage 1, the gates or hydration throw                                                             | —                                                                                               | `degraded: true`, exactly as hard rule 2 |

A fallback replayed from the cache records `cached_fallback` when a snapshot is held (its reason was not cached), else the holder's current reason.

**Cache key.** `sha256('v1_tags' | prompt | baseModel | browsingLevel | cap | 'addon' | snapshot | tagsSpecHash | RESOURCE_INTENT_V1_GATE_SPEC_HASH | RESOURCE_INTENT_SPEC_HASH)`, where `snapshot` is the held index's payload sha256 (which covers its vocabulary and tables) or `fallback`, and `tagsSpecHash` is `RESOURCE_INTENT_TAGS_SPEC_HASH` ('' without a snapshot). `RESOURCE_INTENT_V1_GATE_SPEC_HASH` (`resource-intent-tags/gate.ts`) fingerprints the request-time base-model gate, the choice of which add-on requests get it (`v1ListBaseModelFilter`'s output on fixed inputs; a change at its call site does not move it), and the ecosystem floor, so a change to either busts the key without moving the tags spec hash, which selects the snapshot a pod serves. No other mode's key ends in the stage-1 hash, so the keys are disjoint, and turning the flag off returns to keys that were never shared. The co-occurrence snapshot is not a term: a fallback can serve, for up to its 60 s, a list from a co-occurrence snapshot replaced within that minute.

**Shadow.** Computed after the response: it waits until the current turn has finished (so after the route has written the response), and the row's `latencyMs` and `time` are taken before it starts. It makes no vendor call and has no response cache: each one costs at most one in-memory scoring, one coverage-audience evaluation of its own, one search-index query and one hydration, cache hits included. Its search shares the foreground's limiter (`withMeiliResourceSelect`, which queues), but at most 4 shadows run at once on a pod (`V1_SHADOW_MAX_IN_FLIGHT`); past that a request's shadow is skipped (`shadowReason = 'skipped'`), never queued. A throw becomes `shadowDegraded = 1` on the row and never reaches the response. It is not computed on a served `v1_tags` row; shadowing POOL_MERGE beside a served v1 is not built. Its columns and those of a served v1 row are in `src/server/clickhouse/migrations/2026-10-17-resource-intent-shadow-v1.sql`, still one row per request; they record how many tags were found (`literalTagCount`), never which. 🔴 Any shadow-health rate (an alert, or the judged comparison's guard on degraded and fallback rows) must leave out `skipped` and `loading` rows: they mark bursts and cold pods, not an unhealthy arm.

**Judge capture.** While its flag is on, every add-on request (cache hits included) writes `(time, promptHash, prompt, browsingLevel, baseModel)` to `p2m_restricted.routeJudgeSample` (`src/server/clickhouse/migrations/2026-10-17-resource-intent-route-judge-sample.sql`, 30-day TTL). `promptHash` is the shadow row's, so a sampled prompt joins its served and shadow lists, and through that row to the request. No column names the caller, the token or the block instance, so a per-caller cap on the sample cannot be read from this table. 🔴 The `p2m_restricted` database restricts nothing by itself: the table needs its own pair of row policies before the flag opens: one admitting only the comparison's reader, one hiding rows from every other user (the migration header has the order). With no ClickHouse client the row is dropped, never logged; a failed write is not logged or counted either, because the error text could carry the prompt, so after opening the flag confirm that rows arrive in the table.

**Monitoring** reads the shadow table: served fallbacks (`arm = 'v1_tags'`, `v1Fallback`, `v1FallbackReason`) and shadow outcomes (`shadowArm`, `shadowDegraded`, `shadowReason`).

**Before opening, in order** (the DDL is applied by hand; inserts are async, so a row a table cannot take is lost without an error):

1. `2026-10-17-resource-intent-shadow-v1.sql`, after the pool-merge and checkpoint shadow migrations, before `resourceIntentV1Shadow` or `resourceIntentV1` opens.
2. Before `resourceIntentJudgeCapture` opens: create the table (`2026-10-17-resource-intent-route-judge-sample.sql`), then its pair of row policies (applied by an infra owner), then INSERT on that table only for the app's ClickHouse user, then the flag.
3. The holder's own prerequisites (**Holder** above), then `resource-intent-tag-index-holder`.
4. `resourceIntentV1` last, and only once the release is on every pod.

## Hosted models (`needs` → `hostedModels`)

Single-model hosted generators (GPT Image, Nano Banana, Ideogram, …) have no add-ons, so neither the add-on nor the checkpoint list can surface them. A caller that sends `needs` also gets `hostedModels`: entries from the curated catalog in `src/shared/constants/hosted-model-catalog.constants.ts`, matched by capability tag. It is deliberately separate from `ECOSYSTEM_SEO`, and nothing reads one from the other.

- **Request.** `needs?: HostedModelCapability[]`, at most 8 items, each one of `legible_text`, `design_layout`, `photoreal`, `image_editing`, `character_consistency`, `high_resolution` (a claimed native output of at least 2048 px on a side), `transparent_background`, `reference_images`. Any other value is a 400, like the rest of the body. `needs` is answered in the route and stripped before the primitive runs, so it is not in the cache key, the shadow row or the vendor request.
- **Response.** `hostedModels` is present only when `needs` was sent (`needs: []` gets `[]`); a request without `needs` gets exactly the body it got before. Each item is `{key, name, maker, modelId, url, goodAt, capabilities}`: `key` is the ecosystem's `EcosystemRecord.key` (`'HiDream-O1'`, not the `ECO` constant name), `url` is `https://civitai.com/models/<modelId>`. It does not depend on `degraded` or `kind`: a degraded response still carries it.
- **Ranking.** By the number of distinct `needs` an entry covers, then catalog order; entries covering none are dropped; at most 3 (`HOSTED_MODELS_MAX`). The caller's `baseModel` does not affect it.
- **Maturity.** Not filtered: every hosted model is listed in every browsing mode, whatever the ceiling the response echoes in `maturity` (an operator decision). The catalog carries no maturity field, and a test pins that the same `needs` get the same list on a SFW, a mature and a region-clamped ceiling.
- **No vendor call, no cache, no extra rate-limit cost.** It is a pure in-memory match, computed after the primitive returns.

## Caching, rate limits, flag

- **Cache:** full responses under `packed:caches:jev-resource-intent:v1:<sha256>`, TTL 1h. Degraded responses cache for 60s only — a transient vendor failure must not pin an empty result to a prompt for an hour. **A label-read fallback (`insightFallback: true`) takes 60s too**, via its *own* constant `INSIGHT_FALLBACK_CACHE_TTL_SECONDS`: an unordered response must not be pinned for an hour while the analogous vendor failure gets a minute. The flag rides inside the cached blob, so a replay reports what the computation did rather than a fresh `false`. POOL_MERGE (`coocFallback`) and v1_tags (`v1Fallback`) fallbacks take 60s as well, each under its own constant.
- 🔴 **The degraded and label-read TTLs are separate constants at the same value, because their RETRY COSTS are not alike** and a TTL buys retry cost, not response quality. The label read sits *between* stage 1 and stage 3, so a fallback miss has already paid stage 1 and goes on to pay stage 3 in full — three billed vendor calls plus two search queries (the seed page and the 500-document `basePool` page) and hydration — where the dominant degraded case (stage-1 Jev throwing) costs one abandoned call and nothing downstream. The benefit inverts as well: a degraded response is useless so a fast retry is worth paying for, while a fallback response is fully usable and merely unranked. **Consequence to weigh before opening the flag:** against a *recurring* fault a repeated prompt re-runs the whole pipeline up to 60× per hour instead of once, and one trigger is not transient at all — an unapplied `ResourceInsight` migration is one of M2's operational preconditions and is the default state of a fresh environment. Two things that would make this measurable rather than reasoned do not exist yet: no shadow column or metric for the state (only a fire-and-forget log), and no single-flight around the cache's compute. The value is deliberately left at 60s and un-jittered — those are judgments for whoever opens the flag.
- **Rate limit:** per-`blockInstanceId` LLM bucket (`:llm:` sub-namespace, 30 req/60s, fail-open) — a request is up to three vendor calls, so it does not share the catalog bucket.
- **Flag:** `resourceIntentJev` in `feature-flags.service.ts` (`availability: []`, fliptKey `resource-intent-jev`). Flipt owns the decision; an unknown flag or unreachable Flipt denies. The flag is checked **before** the cache read — a dark endpoint never reads and never spends. The Flipt flag definition itself is a separate flipt-state change and must ship default-OFF. `resourceIntentPoolMerge` (fliptKey `resource-intent-pool-merge`) picks the [POOL_MERGE arm](#the-pool_merge-arm-co-occurrence), `resourceIntentCheckpoint` (`resource-intent-checkpoint`) admits [checkpoint mode](#checkpoint-mode-kind-checkpoint), and `resourceIntentV1`, `resourceIntentV1Shadow` and `resourceIntentJudgeCapture` (`resource-intent-v1`, `resource-intent-v1-shadow`, `resource-intent-judge-capture`) drive [the v1_tags arm](#the-v1_tags-arm); all are dark, read only behind it, and each needs its own default-OFF Flipt definition.

## Label ordering

`ResourceInsight` holds one meaning/quality row per labeled model version
(`role`, `styleFamily`, `contentTypes`, `qualityScore`, `confidence`, `specHash`,
`stale`), written offline by `scripts/label-resource-insights.ts`. The matcher
reads it to order the shortlist.

**What it orders, and what seeds it.** The ordering permutes a candidate pool that
`searchShortlistModels` seeds from ONE index page: the gate filter, sorted
`metrics.thumbsUpCount:desc`, `poolCap` documents wide. No role filter and no quality
key — the labels act only through the ordering below.

Why popularity alone. Two label-driven seeds came before it. A single
quality-first sort with no role filter ranked labeled models by quality regardless of
purpose, so a busy type × baseModel cell filled the pool with labeled models for other
purposes. Its replacement seeded by PURPOSE first (the filter AND
`insight.role = <requested role>`, quality-sorted, topped up by popularity only when
short). Registration v2 of the M3 study judged that seed NOT MET: it retrieved attached
models about half as often as popularity alone. A separate 254-prompt diagnostic
(2026-10-06) found why: in 204 of 254 requests (~80%) the role-filtered page filled the
pool on its own and evicted the popular model the user had actually attached. An offline 254-prompt replay then screened 18
seed designs; the only one that tied popularity on hit@10 (26 vs 25) and led it on
MRR@50 (0.050 vs 0.022) was this one — the popularity page alone, with the label
ordering on top — and every design that put role-filtered documents into the pool
lost. That is a screen, not a verdict: registration v3 of the study (see
[The M3 study](#the-m3-study-a-pre-registered-retrieval-comparison)) judges it, and has not
been run.

The seed reaches `applyInsightRanking` only as the tiebreak index.

🔴 **A label write is ANNOUNCED to the models index, and that is a prerequisite
rather than a nicety.** A model enters the incremental models-index sync on
exactly three conditions, and they live in **two** files: `Model.createdAt >=
lastUpdatedAt` and `Model.updatedAt >= lastUpdatedAt` are in
`prepareModelsBatches` (`src/server/search-index/models.search-index.ts`); the
third — the index's own update queue — is read by `update()` in
`src/server/search-index/base.search-index.ts`, which unions the queued ids with
that function's `updateIds`. A `ResourceInsight` upsert satisfies none of them —
it touches neither `Model` column — so nothing about a label would reach the
index except through the manual full re-projection, which can go a very long
time between runs. The labeling pass therefore enqueues the affected MODEL ids
(`ResourceInsight` is keyed per version; the index is keyed per model) on every
batch that writes rows.

The insight fields ARE now projected into `models_v9` (`insight.qualityScore`,
`insight.role`, `insight.styleFamily`), so the enqueue is what keeps them current.
Without it they would be frozen at the last manual reset, decaying from the moment it
finished, with every newly-labeled model carrying a null role. No query serving
requests reads these fields now — the matcher reads labels from Postgres — so the
cost of a stale projection today falls only on a future `insight.*` filter. **Touching `Model.updatedAt` instead was considered and
rejected:** it orders the "recently updated" model lists (`model.service.ts`
already drops to raw SQL to AVOID bumping it on a non-creator edit, and says
so), so a corpus labeling pass would misrepresent every labeled model as
freshly updated.

🔴 **The per-batch enqueue is sized for the STEADY-STATE trickle. Price a
full-corpus pass before running one.** What is verified in code:

- The drain is `search-index-sync-models`, cron `*/15 * * * *`
  (`src/server/jobs/search-index-sync.ts`), and its `update()` gate is
  `lastUpdatedAt + updateInterval < now` with a 30-second default
  (`src/server/search-index/base.search-index.ts`) — so **every** cron fire
  drains, continuously, for the whole duration of a pass.
- That `update()` runs with `db: dbWrite` / `pg: pgDbWrite`, so each drained
  model is a full nested `modelSearchIndexSelect` pull **off the primary** — not
  the replica. `reset()` is the one that uses `dbRead`/`pgDbRead`.
- The rebuilt documents carry the projected insight fields (`insight.qualityScore`,
  `insight.role`, `insight.styleFamily`), so a drained model is a real
  re-projection, not a no-op.
- The index holds **~700k ungated documents** — the figure is
  `src/pages/api/admin/temp/queue-paid-models-reindex.ts`'s own, in a comment
  that declines to rewrite them because "rewriting them would be waste".

Two corrections to the obvious reasoning, both of which bit an earlier draft of
this paragraph:

- ⚠️ **Queue DEPTH is a count of DISTINCT MODELS, not of versions labeled** —
  which is a correction to the _mechanism_, not a cheaper cost estimate, and
  billing it as the latter is what bit the earlier draft. The queue is a redis
  **set** (`sAdd`, and `checkoutQueue` collects into a `Set`). 🔴 **It is a
  different quantity from the script's `indexQueued` total, so do not read
  either off the other.** `indexQueued` is a **pass**-scoped sum of per-batch
  announcement lists, deduplicated only _within_ each batch, so a model
  announced by two batches is counted twice. Standing depth is a
  **per-drain-window** quantity that this pass only _contributes_ to: the queue
  is shared with every other `queueUpdate` caller, and the `models` sync drains
  it every 15 minutes (`src/server/jobs/search-index-sync.ts`,
  `models: '*/15 * * * *'`). Which batch a model's versions land in follows from
  the ordering: on the **default** sweep (`id > cursor`,
  `orderBy: { id: 'asc' }`, `take ≤ 10` per batch —
  `scripts/label-resource-insights.ts`) a model's versions are created at
  different times and so are not adjacent in id space, which is why they can
  land in different batches; under `--top`
  (`orderBy: [{ generationCount: 'desc' }, { modelVersionId: 'asc' }]`) usage
  correlates within a model, so several of its versions _can_ land in one batch,
  where `labeledModelIds` collapses them — ⚠️ statistically, not by
  construction, since nothing in that ordering groups by model. Hence the double
  count is near-certain on the default sweep and rarest under `--top`.
  🔴 **Three of these quantities are recorded nowhere in this repo** — batch
  throughput, per-model version-id spacing, and actual standing depth. `docs/`,
  `scripts/` and `src/` were swept at this head and hold no figure for any of
  them, which is weaker than nobody having measured them; do not size anything
  on those three until a run produces figures. The versions-per-model
  distribution, however, **is measured**: `docs/plans/model-ui-overhaul.md`
  records it from the production database, and **84% of models have exactly one
  version** — for which a cross-batch double count is structurally impossible.
  Summing its buckets at their floors puts the mean at **≥ ~1.24 versions per
  model**; the open-ended `6+` bucket makes the true figure somewhat higher, but
  nothing in the distribution gets it near 2. So `indexQueued` over-reports
  distinct models by a fraction, **not by a multiple**. ⚠️ That bounds the
  quantity without pinning it: its corpus is every `Model` row (type-mixed)
  rather than the `LABELABLE_VERSION_FILTER` published/non-private subset this
  pass walks, its buckets are ranges rather than exact counts, and its `20+` row
  is presumably a subset of its `6+` row.
- ⚠️ **`--top N` DOES bound the announced set, PER INVOCATION** —
  `topUsageVersionIds` takes at most N ids in one query, so one run announces at
  most N models. It does **not** bound a resumed pass: `--cursor` re-materialises
  the ordered list on every resume, over a `generationCount` that moves while the
  run is in flight, so the union of models announced across the resumes of one
  logical pass can exceed N. What it bounds even less is per-document size, and
  ordering by `generationCount` plausibly selects larger documents (more
  versions, files, showcase images). That last clause is a correlation nothing
  in this repo measures.

🔴 **There is no `--no-enqueue` lever, so a corpus pass cannot be run without
announcing**, and because the cron drains every 15 minutes a "finish with a
reset instead" plan does not avoid the incremental cost — most of it is already
paid by the time the pass ends. If that cost needs avoiding, it needs a flag on
this script plus pausing the drain, neither of which exists in this repo today.
`search-index-sync-models-reset` is still the cheap way to make the whole corpus
consistent now that the insight fields are projected: it is a manual-trigger job that
builds off the replica, swaps, then clears the queue.

Apart from the versions-per-model distribution cited above — which bounds the
over-report without sizing the pass — none of the cost quantities above is
measured against the database. The distinct-model count is the number that
decides the real cost, and a corpus run should derive it first.

The pool is wider than the response — `min(cap × 2, 255)` — so the ordering can
promote a candidate the seed placed outside the shortlist rather than only
reshuffling the visible page. 🔴 Read that bound literally: the widening shrinks
from `cap = 128` and is **1× at the maximum accepted `limit` of 255**, where the
ordering really can only reshuffle the visible page. It is the default cap of 50
that gets a 2× pool.

**Three buckets, not a score.** 🔴 **Read the coverage numbers before the table — the
ones that used to stand here were the wrong denominator, and the argument built on
them is withdrawn.** Coverage is ~1% over the whole eligible corpus (9,900 labeled
versions of ~0.94M), and that figure is what an earlier version of this section used
("only a small fraction of eligible versions carry a row"), as the *justification*
for bucketing rather than scoring. It is the rate over a population the ordering
never sees. The labeled set is the catalogue's high-usage head — the lowest
`generationCount` among labeled versions is 46,798 — so coverage inside a
popularity-ordered page runs **~30–45× the corpus rate**. Those figures were measured on
popularity-ordered populations without the gate filter, so they approximate the pool
(itself a popularity-ordered page) rather than measure it:

| Population | Label coverage |
| --- | --- |
| whole eligible corpus | ~1% (9,900 of ~0.94M) |
| versions of the top 100 models by thumbs-up, no type filter | **33.3%** (350 of 1,050) |
| versions of the top 100 LoRA-family models by thumbs-up | **~45%** (236 of 522) |

Measured against the primary Postgres database three times independently — by the
reviewer who raised the retraction and by two auditors — and ⚠️ **not reproducible
from this repo**: the queries were not captured, so re-run them before building on
the figures rather than citing this table. Two consequences, and the second is the one that was being argued the wrong way round:
insight coverage correlates with popularity, which anyone grading label ordering
against a popularity baseline has to control for; and **the ordering is active on a
large share of requests rather than being a rare no-op**, so eviction from the
returned slice (the red-flagged paragraph below) is routine, not exceptional.

**So bucketing has no coverage argument behind it any more, and this document is not
substituting a new one.** What survives is a property rather than a justification: a
labeled and an unlabeled candidate share no scale, so any scoring scheme has to
invent a score for the unlabeled candidates, and the neutral band is how this
ordering avoids inventing one. Whether buckets or scores serve better at the in-pool
coverage above is tested nowhere in this repo; it is the first thing to revisit
once the shadow table can grade the ordering (see the closing condition at the end
of this section). The policy as it stands:

| Candidate | Bucket |
| --- | --- |
| label agrees on role and style family | promote (3) |
| label agrees on role only | promote (2) |
| label agrees on style family only | promote (1) |
| no row, or `confidence` below the floor for its direction | neutral (0) — seed order preserved |
| label at or above the **demote** floor agreeing on neither axis, whose role this build recognises AS AN ACTUAL ROLE | demote (−1) |

Nothing is FILTERED: an absent label never disqualifies a candidate, and the
ordering is a permutation of the pool. An unlabeled candidate sits **above** a
disagreement that cleared the demote floor and **below** a confirmed agreement; it is
never scored as a zero, which would bury the unlabeled majority under any
weakly-labeled row. `qualityScore` separates candidates inside either labeled bucket,
never for a neutral one — there is no quality score to compare an unlabeled candidate
against. Worth stating because it follows from the table rather than being written
anywhere else: a single label agreeing on one axis at the bare promote floor outranks
the entire unlabeled majority. That is the design — an agreeing label is the evidence
this ordering exists to use — but it is the first lever to revisit if the ordering
turns out to hurt.

🔴 But the permutation is then **sliced to the response cap**, so on a pool wider
than the cap the ordering decides *which* resources are suggested, not only their
order — a promotion into a fixed-width page is an eviction out of it, and what gets
evicted may be an unlabeled candidate. The SEED excludes too, by popularity: a labeled
match less popular than the pool's last member never reaches the ordering. What is
bounded is the WIDTH: one seed page of at most `poolCap` documents, plus one
`RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT` page for `basePool`, each under
`MEILI_RESOURCE_SELECT_TIMEOUT_MS`. ⚠️ Since HYBRID_10 the ordering reaches the response
only through stage 3's head (≤ 10 models, ties broken in re-rank order); the fill past
it is `basePool`, in popularity order, which no label touches.

Four details that are decisions, not oversights.

**`other` is not agreement.** A `styleFamily` of `other` means "none of the above"
on both sides, so `other` ↔ `other` does not count. Consequence worth knowing: for
a request whose compiled `styleFamily` is `other`, the style axis is dead and the
"agrees on style family only" row of the table above is unreachable — that slice
degrades to role-only.

**The confidence floor is a four-axis minimum — and there are now two of it.**
`ResourceInsight.confidence` is the weakest of a row's four label judgments,
`contentType` included — the axis the ordering never reads. So a row can fall below
the floor on the confidence of a question this design calls unusable. Only the
aggregate is persisted, so nothing here can separate them.

🔴 The promote and demote directions read **separate constants**,
`RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` and
`RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE`, which hold the same value today — so
behaviour is exactly what the single constant gave, and the split is a lever rather
than a change. The numbers live in the code, deliberately not restated here: moving
the demote floor is the whole point of the split, and a literal in this sentence
would be false the moment someone does it. The
reason they are separate: the measured argument for that value (p50 0.43, only 3.4%
of rows at 0.70+, so a 0.70 floor leaves the ordering inert) weighs **only** the
promote side's cost, which is a label that never gets to help. The demote side's
error costs run the other way — raising its floor costs a *missed* demotion, and a
row that fails to demote just sits neutral in seed order, i.e. the pre-feature
behaviour, while a demotion on a pool wider than the cap *evicts* a candidate from
the returned page. The demote value is therefore inherited from an argument that was
never about it. Measured on a realistic pool approximation: in the worst cell sampled
the demote bucket held 49 of 100 candidates, median confidence 0.45, **none at
0.70+** — which is why this document no longer calls it the "confident" bucket. It is
deliberately NOT raised here; where to put it is a product judgment about how much
eviction an unvalidated label may cause, and that judgment has not been made.

**`stale` is a floor, not a freshness guarantee.** Nothing in this repo sets
`stale = true` — the migration describes that flip as a manual step of a label-spec
bump — so the clause excludes no row today, and `specHash` is deliberately not
compared: filtering on it would make the ordering inert from the moment a spec
moves until a vendor-spend-gated re-label pass finished, and the table was designed
so superseded rows stay readable. (`specHash` holds the LABEL spec's hash, which
lives in `scripts/label-resource-insights.ts`, so comparing it would also make a
server service depend on a CLI script.) What protects a superseded row from doing
harm is the demotion rule instead: **demotion turns on the `role` alone, and only on
a role this build recognises AS AN ACTUAL ROLE.** A taxonomy edit supersedes every
row's spec *and* makes its strings unmatchable in one move, so demoting on a value
nobody can interpret would bury the whole labeled population beneath the unlabeled
majority. Note what that does and does not say: an unrecognised `styleFamily` beside
a recognised *disagreeing* role still demotes, because the role is the evidence; and
the second half of the rule is the `none` decision below, not a restatement of the
first. The residual, resolved either by the manual `stale` flip or by re-running the
labeling pass: a spec that keeps an option's spelling and changes its meaning.

**`none` is not a disagreement either.** The fourth decision, and the one that is
easiest to get wrong, because `none` IS in the role option list — so a plain
membership test treats it as recognised and demotes on it. It is the taxonomy's own
"no role at all", the labeller declining to place the resource, not evidence of a
different purpose, and demoting on it makes being LABELLED a penalty: a resource the
pass could not classify would rank below an identical one it never reached, and on a
pool wider than the cap that is an eviction rather than a reorder. So a `none` row is
neutral — indistinguishable from unlabeled, `qualityScore` included. It can still
PROMOTE on the style axis, because the style question has its own option list with no
`none` in it, so a style family sitting beside `role: 'none'` is a positive answer to
a different question rather than a second decline.

`contentTypes` is **not** read. The v1 label spec asks a singular single-`choice`
question and wraps the answer in a one-element array, so the column has one value
per row and its modal value is the catch-all — there is nothing to rank on until
the question becomes multi-select.

An unreachable label table costs the ordering and nothing else: the matcher logs
`resource-intent-insight-read-failed` and returns the seed order, rather than taking
the whole response down to `degraded: true`.

🔴 **But it REPORTS that, and it used not to.** The matcher returns
`{ entries, insightFallback }`, the service puts `insightFallback` on the response,
and a response carrying it **caches for 60s instead of an hour**. Before that, the
fallback was silent at the seam: the caller received a well-formed, correctly-capped
shortlist with no way to learn the labels were never read, so `degraded` stayed
`false`, the full-hour TTL applied, and a replica blip or pooler timeout pinned an
*unordered* response to that cache key for an hour — while the analogous vendor
failure got a minute. Note what `insightFallback: false` does and does not claim: it
says no label-read failure happened, **not** that the ordering changed anything. An
empty pool, a pool with no labeled version, and a pool every label left neutral all
report `false`.

🔴 **The shadow table still cannot see any of this, and that gap has to close before
M4/M5 read it.** `ShadowEvent` records no insight field — `insightFallback` is on the
response and in the cache, not on the ClickHouse row: the table has no such column,
so adding the field to the writer ahead of the DDL produces nothing anyone can query
whatever ClickHouse does with it. So a shadow row produced by the fallback above is indistinguishable from one
whose pool simply held no labeled version, which is in turn indistinguishable from one
the labels reordered. Grading "do the labels help" against that corpus is not
possible. Harmless today only because the endpoint is dark.

Two things make the obvious fix insufficient, so the closing condition has to name
them. (a) `writeShadowEvent` fires on every call **including cache hits**, where the
matcher never ran — which is why `shortlistCount` is already reconstructed from the
response rather than left at 0. So a fallback-ordered response emits one marked row
and then up to an hour of unmarked ones unless the fields ride **inside the cached
blob**, i.e. in `resourceIntentResponseSchema`, which is itself another
cache-invalidating shape bump. ⚠️ **That bump has now been paid once**, for
`insightFallback` — so the PRECONDITION (a) names is met, and any further column
should go in the same place rather than beside the response. 🔴 Read that as a
precondition and not as the fix: (a) is a claim about what the shadow ROWS look
like, and with no column and no `ShadowEvent` field there are still **zero** marked
rows, which is exactly the pre-change state. What changed is that the value now
exists and survives a cache replay.
(b) A pooled label count cannot separate "the labels reordered this" from "every
label landed neutral" — below the floor for its direction, or unrecognised, both of
which this design makes deliberately common. That needs a reorder signal, not a
population count, and `insightFallback` is not one: it answers "could the ordering
run", never "did it change the answer".

🔴 And a count of actionable rows is still not a reorder signal: at the default cap
half the pool sits outside the response, so demoting a candidate the seed had already
placed there moves nothing the caller sees while counting as actionable. (Since
HYBRID_10 the returned list is not the shortlist: positions past stage 3's head come from
`basePool`, which the labels never touch, so clause (i) below has to be read against the
stage-3 head, the only part the ordering can reach.) A class
defined that way dilutes the treatment arm with responses identical to the control
and biases the measured effect toward zero — the same failure one step further in.

**Closing condition (unchanged, and still open):** columns ON the
`resourceIntentShadow` table carrying (i) whether the ordering changed the RETURNED
slice — not how many rows were actionable — and (ii) whether the ordering ran at all;
both carried in the cached response so a replay reports the same values as the
computation; verified by a query returning a non-empty, disjoint partition of rows
into changed-the-response / ordering-ran-but-response-unchanged /
ordering-did-not-run.

Progress against it, stated precisely so nobody reads this as closed: clause (ii)
asks for a COLUMN, and there is no column. What exists is the **value** such a
column would carry, for one case of (ii) — "the ordering could not run because the
label read failed" — computed, put on the response, and carried through a cache
replay as the condition requires. It does not distinguish *ordering ran* from
*ordering ran on a pool with nothing to order*, and it says nothing at all about
clause (i). Closing either clause still needs the ClickHouse columns, the
`ShadowEvent` fields to populate them, and for (i) a comparison of the returned
slice against the slice the seed order would have produced.

### The M3 study: a pre-registered retrieval comparison

`scripts/eval-resource-intent-goldset.ts` is committed and its own header says so:
without `--execute` it prints its queries and the pre-registration below, and exits;
a live run needs a replica read, the models index and a vendor key. ⚠️ An earlier
version of this section said the study had been "removed before merge" and was
"parked on a branch" — that was wrong in the direction that wastes someone's day,
since the runnable evaluator was in the tree the whole time.

It has two parts, both drawn under ONE eligibility rule — the publicly searchable image
(`imageWhere` in `src/server/search-index/images.search-index.ts`) with a public,
non-empty prompt and no attached model flagged POI or minor, since those prompts go to the vendor. The matched draw is shared:
part one takes a prefix, part two the first `sampleSize`; part one's unmatched half is
a separate draw. **Part one** measures **stage-1 agreement** against that
corpus (role vs the resource types a prompt actually attached, `needsResource`
calibration, review-rate curves). It runs stage 1 through the endpoint's own
`buildResourceIntentStage1Request` / `parseResourceIntentStage1Answers`, and its report
says how many drawn rows a stage-1 failure skipped.

**Part two** (`scripts/eval-resource-intent-retrieval.ts`) grades the resource-meaning
layer's last closing clause: *"the M3 gold-set study shows the purpose-query arm
beating the popularity arm on its pre-registered metric"*; v3 reads that clause as the two
co-primaries below. Per sampled prompt it runs
stage 1, then both arms with the same criteria, `browsingLevel`, coverage and cap.
PURPOSE is `findResourceIntentCandidates` itself. POPULARITY is the pool that same call
ranked (returned as `pool`), cut to the cap and never handed to the label re-rank: one seed
per prompt, so the two arms differ only by `applyInsightRanking`. Neither arm calls stage 3.

**The pre-registration lives in code, not here:** `M3_RETRIEVAL_PREREGISTRATION` in
`scripts/eval-resource-intent-registration.ts`, rendered as text by
`renderRetrievalPreregistration()`. Read it by running the script without `--execute`
(`pnpm run tsscript scripts/eval-resource-intent-goldset.ts`), which prints the committed
queries and that text and exits 0. It still needs the server env to validate, but it
loads no database or search client, so it needs no Prisma engine, no database and no
index; every report opens with the same text.

**Registration v3 (2026-10-07) is the running one.** v2 graded the then-shipped
purpose-first matcher and its registered run judged it NOT MET. That verdict is binding,
and v2 stays in the file verbatim (`M3_RETRIEVAL_PREREGISTRATION_V2`,
`renderRetrievalPreregistrationV2()`), pinned by its sha256 in the dry-run smoke test.
v3 asks a new question of the popularity-seed matcher, in brief:

- **Co-primary, both must hold for MET** (intersection-union, no alpha split):
  (i) non-inferiority on hit@10 with a 0.02 absolute margin — d = (b − c)/n,
  se = sqrt(b + c − (b − c)²/n)/n, holds iff d − 1.645·se > −0.02; and
  (ii) superiority on MRR@50 — an exact two-sided sign test over prompts whose reciprocal
  rank differs, holds iff up > down AND p < 0.05. Otherwise **NOT MET**.
- **VOID** takes precedence: a registered value was overridden (the pilot included),
  fewer than 1334 prompts scored (2000 drawn × 66.7%), infrastructure exclusions above 10%
  of drawn prompts, or the positive control fails.
- **Positive control** — on what PURPOSE actually reads: VOID if fewer than 10% of scored
  prompts had at least one pool version the re-rank promotes (a `ResourceInsight` label at
  or above the promote floor agreeing on role or style family). The matcher reports that
  count as `promotableVersions`. It replaces v2's index-document count, which no arm reads
  any more.
- **Identical heads are a diagnostic only.** v2 voided a run whose arms matched on every
  prompt's top 10; the arms now differ only by the re-rank, so identical heads are expected
  on most prompts (as a proxy: reciprocal ranks @50 tied on 220 of the offline replay's 254
  prompts), and the count is printed without deciding anything.
- **Power** comes from the 100-prompt pilot's nuisance rates — 80 of 100 drawn scored,
  hit@10 discordance 8 of 80 (10.0%), MRR non-ties 22 of 80 (27.5%) — at a planning n of
  1600 scored (2000 drawn × 80%): ≈ 0.81 for (i), ≈ 1.00 for (ii). At the 1334 scored
  floor, power for (i) is ≈ 0.75. Those figures for (i) hold only at the pilot's point
  estimate of 8/80. The exact (Clopper-Pearson) 95% interval for that discordance is
  4.4%–18.8%, and across it power for (i) runs from ≈ 0.98 down to ≈ 0.58 at 1600 scored,
  and from ≈ 0.97 down to ≈ 0.52 at the floor. The text computes the interval from the pilot
  counts. The one effect-size input, 68% of MRR non-ties
  favouring PURPOSE, is still the planning value from the best-of-18 offline 254-prompt
  replay that selected this design, so it is optimistic; the pilot's effect estimate was
  not used. The text derives all of these from the constants.
- **Re-planned once, 2026-10-07, before any registered run.** The registration as first
  committed planned 1000 drawn (667 scored floor, planning n 822, discordance 13 of 254 =
  5.1%, non-ties 13.4%). The pilot measured 80.0% scored, 10.0% discordance and 27.5%
  non-ties; at those point estimates 1000 drawn scores ~800 and power for (i) falls to ≈ 0.56. Under
  the registration's own pilot rule the sample was re-planned to 2000 drawn from those
  nuisance rates alone; the registration text carries the dated record.

The labeled/unlabeled breakdown is reported but never decisive.

**The pilot has run.** The pilot is `--execute --retrieval-sample 100` — no new flags;
the override stamps the report as not the registered run, so its verdict is VOID by
construction. Its report prints the scored fraction, the hit@10 discordant rate and the
MRR non-tie rate against the planning values, and only a pilot below them prints the
re-plan banner. The rule is to re-plan only in a new commit dated before the registered
run, and say why in it. v3's pilot ran, and its nuisance rates became the planning
values in the one 2026-10-07 re-plan above. A report now compares against those
re-planned values, so the registered run is what comes next.

**Coverage must resolve as the endpoint's does, or the run does not happen.** Both arms
filter on generation coverage from `coverageAudience(undefined)`, which reads Flipt through
`isFlipt` — and `isFlipt` returns `false` both for a flag that is off and when Flipt is
unreachable, so an unreachable Flipt silently grades a filter the endpoint does not use.
`--execute` therefore initialises Flipt and, before any index read or vendor call, aborts
unless a live client exists and evaluates both coverage flags (`isFliptSync` not `null`) —
and also if `FLIPT_LOCAL_OVERRIDES` sets either flag, because a local override is answered
before the client is consulted and would otherwise pass with Flipt unreachable. The report
prints the resolved `{next, member}`. A finished `--execute` closes the Flipt client and
the replica connection, drains stdout and stderr, and exits explicitly (an earlier run
hung on an open handle after writing its report; the drain stops that exit truncating a
report printed to a pipe). The drain-then-exit rule is shared with
`scripts/label-resource-insights.ts` in `scripts/lib/run-as-script.ts`.

**The pilots, and registration v2.** The first v1 pilot (2026-10-06) ran on flag defaults
for exactly this reason and was discarded. The corrected pilot (2026-10-06, Flipt
reachable, coverage resolved live) measured 85.0% scored and a 17.6% hit@10 discordant
rate. Registration v2 differed from v1 only in the live-Flipt abort, the coverage line in
the report, its History text, and its header reading "before any registered run".

What it does NOT do: it is offline, so it grades the ordering on a past corpus and
writes nothing to `resourceIntentShadow` — the shadow-table closing condition above is
untouched by it. And attached-resource gold is biased toward popular models, the
confound the pre-registration states.

## Rollout

- **M1:** primitive + REST surface, dark behind `resourceIntentJev`.
- **M2:** `ResourceInsight` + the labeling script, then the matcher ordering that reads them. Code done. 🔴 **Two OPERATIONAL preconditions are not, and neither is automatic:** `packages/civitai-db-schema/prisma/migrations/20260929170000_resource_insights/migration.sql` is applied by hand per environment, and `scripts/label-resource-insights.ts` must have been run there. Until both hold in a given environment the ordering is wired but has nothing to read, which is a data state, not a code state — and the two are distinguishable from outside: an unapplied migration makes the read FAIL, so the matcher logs `resource-intent-insight-read-failed`, sets `insightFallback: true` and the response caches for 60s; an unrun labelling pass makes the read SUCCEED and return nothing, which is `insightFallback: false` on the full-hour TTL and silently preserves the seed order. An environment stuck on the second therefore looks healthy, by design. **The index projection** — `insight.qualityScore`, `insight.role` and `insight.styleFamily` are projected by the models index; the score is in `modelsSortableAttributes` and all three in `modelsFilterableAttributes`. The matcher no longer reads any of them (its seed is popularity alone), so an index lacking those settings does not affect it, and nothing else reads them either; they are left in place.
- **M3:** the gold-set study — stage-1 agreement, plus the pre-registered two-arm retrieval comparison that grades the resource-meaning layer's last closing clause, quoted in that section. Registration v2 judged the previous, purpose-first seed NOT MET; registration v3 grades the popularity seed and has not been run. Run it only once the seed it grades serves from a `release` build; the decision rule is fixed in [The M3 study](#the-m3-study-a-pre-registered-retrieval-comparison).
- **M4 (suggestions UI)** — NOT implemented. Closing condition: M1 merged + shadow volume ≥1k/day for 7 days + p95 end-to-end ≤2s.
  🔴 **The p95 half of that condition moves under a label-read fault, and no shadow column records why.** In an environment where the `ResourceInsight` migration is unapplied — which this doc elsewhere calls the default state of a fresh environment — a label read that is *issued* fails, so those responses take the 60s fallback TTL instead of the 1h success TTL, and per-key recomputes rise to **up to** 60/hour, each paying three vendor calls plus search plus hydration. Because `writeShadowEvent` fires on cache hits too, the shadow population's miss share rises and its `latencyMs` p95 rises with it. **Do not read a p95 regression as an M4 failure without first checking that the label read is succeeding in that environment**; the shadow table cannot distinguish the two.
  ⚠️ **The volume half is NOT affected, and the clause above is the reason:** the shadow write is unconditional, so rows/day tracks calls/day and is invariant to the miss rate. A volume reading stays trustworthy under this fault — do not discount it.
  ⚠️ **And the 60s signature is absent for two response classes, so its absence does not prove the migration is applied.** A `role: 'none'` answer short-circuits before the matcher runs, and an empty pool skips the label read entirely (it returns before touching the database — this branch's own test pins that as "NOT a fallback: the read did not fail, it never happened"). Both keep the 1h TTL with `insightFallback: false`. A fresh environment is at least as likely to have an unseeded search index as an unapplied migration; the matcher no longer reads the index's `insight.*` fields, so an unseeded index changes nothing here and every response keeps the hour.
- **M5 (auto-attach)** — NOT implemented, and never before BOTH: the threshold study shows per-slice precision ≥0.9 at the chosen operating point AND ≥2 weeks of live shadow agreement ≥80%.

## Verification

Unit suites (fixture-based, no external calls):

- `src/server/services/ai/__tests__/jev.test.ts` — fail-closed parsing, model pin, timeout.
- `src/server/services/__tests__/resource-intent-matcher.service.test.ts` — gates, determinism, cap, the label ordering, its two confidence floors, and the label-read fallback it reports.
- `src/server/services/__tests__/resource-intent-matcher.seed.test.ts` — the popularity-only seed (one seed page plus `basePool`'s 500-document page, both under the gate filter and popularity sort, no role filter, no quality key) against an in-memory index, including that role matches which would fill the pool do not evict the popular models, and that the re-rank still reorders the pool.
- `src/server/services/__tests__/resource-intent.service.test.ts` — cache (including the stage-3 spec hash in the key), degradation, stage flow (two stage-3 calls, `none` keeping the list, the HYBRID_10 head and fill), the fallback's cache TTL.
- `src/server/services/__tests__/resource-intent-stage3.test.ts` — the R4c question and state, the two option orders, averaging and tie-break, the HYBRID_10 merge, and the pinned `RESOURCE_INTENT_STAGE3_SPEC_HASH`.
- `src/server/services/__tests__/resource-intent-hybrid.seam.test.ts` — the service, the real matcher (seed, label re-rank, `basePool`) and the real Jev wire parse together, checked against a verbatim copy of the offline screen's functions on synthetic rows.
- `src/server/services/__tests__/resource-intent-insight-rerank.test.ts` — the service and the REAL matcher together: a label changes the order of a served response, and a label-read failure takes the 60s TTL rather than the hour. The two suites above each mock the other side, so neither can see either of those.
- `src/server/__tests__/blocks/resource-intent.endpoint.test.ts` — auth/clamp mirror, deny-before-spend.
- `scripts/__tests__/eval-resource-intent-goldset.tsx-smoke.test.ts` — spawns the gold-set script under `tsx` (the real entry point) and checks, from a module-load trace, that the dry run loads neither the database nor the search client (on any host), and that it prints its queries and the pre-registration and exits 0 with every `PRISMA_*` variable removed. The in-process suites cannot see a load-time import cycle; this can.
- `scripts/__tests__/eval-resource-intent-retrieval.test.ts` — the M3 retrieval metric math against literal values, the verdict mapping, the pre-registration constants, both arms over an in-memory index, and the CLI gate.
- `src/server/services/__tests__/resource-intent-pool-merge.seam.test.ts` — the POOL_MERGE arm (service, real matcher, real cooc scoring and merge) against a verbatim copy of the co-occurrence screen's code with a `baseModel`, plus literal lists for the no-`baseModel` order; `resource-intent-pool-merge.test.ts` — both merge shapes on literal lists; `resource-intent.pool-merge.service.test.ts` — arm selection, cache key, fallback, study mode, shadow row and the pinned `RESOURCE_INTENT_POOL_MERGE_SPEC_HASH`.
- `src/server/services/__tests__/resource-intent-checkpoint.seam.test.ts` — checkpoint mode's build side (attachment counting through a payload round trip) and both arms (ATTACH_BM, BASE_BM, and the fallback) against a verbatim copy of the offline checkpoint screen's code on synthetic rows; `resource-intent.checkpoint.service.test.ts` — no vendor call, the cache key, the fallback, study mode, the shadow row, and the add-on path unchanged; `resource-intent-cooc.checkpoint.test.ts` — the section's encoding, validation, loading and build.
- `src/server/services/__tests__/resource-intent-cooc.*.test.ts`, `src/server/jobs/__tests__/build-resource-intent-cooc.test.ts`, `scripts/__tests__/build-resource-intent-cooc.test.ts` — the co-occurrence builder. Seam tests hold the tokeniser and sampler to the offline screen's own source (copied verbatim) and the index to a synthetic golden file from its reference builder. The store, retention and heartbeat run against the real migration in PGlite. Also covered: the pipeline's guards, job gating and registration, and the script's flags.
- `src/server/services/__tests__/resource-intent-tags.*.test.ts` — the v1 extractor against a golden fixture of synthetic prompts whose expected values came from running the offline prototype itself; the build against the prototype's own index on synthetic raw inputs, and the scorer on both fixtures through the real encode and decode; each decoder refusal; the auditor exclusion; the input readers' standby guard and user hashing; the content-image moderation predicate, pinned whole; the pinned `RESOURCE_INTENT_TAGS_SPEC_HASH`; the angle-tag strip against the regex it replaced (adversarial and random strings) and a linear-time check on a run of `<`; and the vocabulary table's CHECKs and unique key against the real migration in PGlite. `resource-intent-tags.pipeline.test.ts` and `src/server/jobs/__tests__/build-resource-intent-tag-index.test.ts` — the build job: each gate reached with a case every earlier gate passes, the newest frozen vocabulary built and stored against both real migrations in PGlite, the flag, schedule and registration, and no generator prompt in the slow-audit log. `resource-intent-tags.holder.test.ts` and `…holder-wiring.test.ts` — the holder: with its flag off no read, download, decode or module import (and a held snapshot dropped); with it on single-flight loads, the poll and retry intervals, never waiting once something is held, keeping the old index until the new one loads, the unservable memory (kept while the refused row is ready) and its fallback to the previous ready row, retryable versus refused failures, its own spec hash only, and the timeout's abort with no overlapping check. `…decode-worker.test.ts` — the committed worker bundle against a fresh one, Node-builtin requires only, the same index as the main-thread decoder without unpacking on the calling thread, and each failure's meaning. `…retention.test.ts` and `…heartbeat.test.ts` — retention against both real migrations in PGlite (retire through the trigger, delete only objects this database's retired rows name, never an object it did not name, and one failed delete not stopping the rest), the job's heartbeats and their gauges, and the holder's metrics.
