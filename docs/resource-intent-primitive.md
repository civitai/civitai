# Resource-intent primitive (Jev)

**Status:** **M1 + the M2 consume seam** — the primitive and its REST surface, dark behind `resourceIntentJev` (default-deny), with the shortlist now ordered against the `ResourceInsight` labels. The candidate POOL is still seeded by popularity; see [Label ordering](#label-ordering) for what that does and does not buy. M3 (the gold-set study) does not exist. M4/M5 are gated follow-ons — see [Rollout](#rollout).

A versioned, headless API primitive: **prompt → intent + criteria → civitai resource suggestions**. A prompt becomes a typed intent (what kinds of resources it wants, with full probability distributions), the intent compiles into a deterministic shortlist over the model search index, and a second judgment ranks the shortlist. `none` is a first-class answer at every stage — most prompts need no resource.

The judgment model is [TypeSafe Jev](https://openrouter.ai) (`typesafe/jev-1.13`) via OpenRouter — a bounded-judgment vendor: Choice (full distribution over ≤255 options), Score (ordered rubric), Noul (P(yes)). It cannot generate prose, count, or compare dates, so everything structural stays in deterministic code.

🔴 **Transport: `POST https://openrouter.ai/api/alpha/decisions`, never chat/completions.** `typesafe/jev-1.13` is a _decisions_ model; posting it to `/api/v1/chat/completions` returns HTTP 400 in ~200 ms with `"typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."` The first implementation of `services/ai/jev.ts` did exactly that — flattening its own `{state, questions}` contract into chat messages — so **every call this primitive ever made in production returned 400 and degraded to empty suggestions**, from its first request. It was found by one live call with two controls (the same key/endpoint/parameters with a chat model returns 200; the model's own metadata endpoint confirms it exists with `supported_parameters: []`, which was the tell all along), and it survived a six-round audit and a comprehensive green test suite because **that suite mocked the vendor**. A green suite over a mocked seam is a claim about the mock. The wire contract is documented in `src/server/services/ai/jev.ts`; OpenRouter publishes no docs page for it (`/docs/api-reference/decisions` → 404) and it is an **alpha** endpoint, so re-verify before relying on any detail.

Three consequences worth knowing before you read the rest of this document: `questions` and `answers` are **records keyed by id**, not arrays; a Score answer is an **index into its `criteria` array** (`0 … criteria.length - 1`), mapped back to the declared `min`/`max` by the adapter, which is why `askJev` refuses a question whose `criteria.length !== max - min + 1`; and a Noul answer carries **no confidence**, so any aggregate over an answer set must exclude it rather than default it to 0 (`jevConfidenceFloor`).

## Architecture

```
POST /api/v1/blocks/resource-intent {prompt, baseModel?, limit?}
  → [redis cache, key sha256(prompt|baseModel|browsingLevel|cap|specHash), TTL 1h]
  → Jev request #1: 6 questions, one round trip      (src/server/services/ai/jev.ts)
  → criteria (versioned object, criteriaVersion: 2)  (src/server/schema/resource-intent.schema.ts)
  → matcher: Meilisearch models_v9 filtered, popularity-seeded
      → version pool ≤ 2 x cap
      → ordered against ResourceInsight (primary Postgres database)
      → shortlist ≤ min(limit||50, 255) versions
  → Jev request #2: one Choice over the shortlist, `none` fallback
  → response {intent, criteria, suggestions[], model, criteriaVersion}
  → shadow event → ClickHouse resourceIntentShadow   (graceful fallback to structured log)
```

| File                                                     | Role                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/services/ai/jev.ts`                          | Vendor seam. Pinned model, fail-closed validation, 2s timeout.                                                                      |
| `src/server/schema/resource-intent.schema.ts`            | Question spec v1, criteria schema, role→ModelType mapping, spec hash.                                                               |
| `src/server/services/resource-intent.service.ts`         | Cache → stage 1 → criteria → matcher → stage 3 → hydration → shadow event. Plain async function; reusable without the REST surface. |
| `src/server/services/resource-intent-matcher.service.ts` | Deterministic gates + popularity-seeded pool + `ResourceInsight` ordering + hard cap.                                               |
| `src/pages/api/v1/blocks/resource-intent.ts`             | Block-token REST surface.                                                                                                           |
| `scripts/label-resource-insights.ts`                     | The offline batch pass that WRITES `ResourceInsight`. Run manually; spends vendor budget on every invocation, dry run included.      |

## Hard rules

1. **Pin the model.** `typesafe/jev-1.13` (numbered). `jev-latest` never appears in code. ⚠️ **This rule used to read "the client sends `allowFallbacks: false`, so OpenRouter cannot route the call to a different model while we record ours", and that is RETRACTED** — it described the chat/completions transport, which could never have worked at all (see the transport note below). The decisions endpoint's only proven request shape is `{model, state, questions}`, and sending an unverified `provider` key to a strictly-validated alpha endpoint is how the original defect happened. The pin is now enforced on the **response** instead: the vendor reports the build that answered (`typesafe/jev-1.13-20260917` for the pinned `typesafe/jev-1.13`), `askJev` fails closed on anything that is not the pin or a dated build of it, and `JevResponse.model` carries that vendor-reported build rather than our constant. That observes what actually ran instead of requesting a routing promise.
2. **Fail closed, fail empty.** Any Jev error/timeout/malformed response returns HTTP 200 with `degraded: true` and `suggestions: []`. Never a stack trace, never fabricated suggestions.
3. **Deterministic gates always win.** Availability (no Private), the token's `maxBrowsingLevel` maturity clamp (authoritative — no client maturity field is read), region restriction, canGenerate coverage, baseModel compatibility (caller-supplied, never Jev output), and the hard-coded `celebrity` tag exclusion are applied in the matcher. Hydration re-checks exactly TWO of them — `hasAccess` and the maturity ceiling. Coverage, baseModel and the celebrity exclusion are NOT re-checked there, and `canGenerate` is present on the hydrated resource and unread. ⚠️ **No principle separates the two re-checked gates from the three that are not.** An earlier draft of this line said the re-checked ones are "the ones whose indexed value can lag"; that is false — the source comment beside the check says the _coverage_ filter is a superset that can lag, and coverage is gated on indexed Meili fields exactly like the rest. So the honest statement is that a version whose coverage lapsed since the last index build can still be suggested. Treat that as an accepted gap with no stated justification, not as a designed boundary — and if you close it, `canGenerate` is already on the object. Jev output can only reorder/drop within the gate-passing set, never add — the stage-3 option list contains exactly the shortlisted keys plus `none`, so an unknown version is unrepresentable.
4. **`none` is a first-class answer.** Stage-1 `role` includes `none`; stage 3 includes `none`. An argmax of `none` returns empty suggestions _without_ `degraded`.
5. **Stable question IDs + spec hash.** `QUESTION_SPEC_VERSION` plus a sha256 over the question spec ride every response and shadow row; a question edit invalidates old analytics instead of blending with them. 🔴 **The spec term in the CACHE KEY is the hash, not the version** — the hash moves on any spec edit, the hand-maintained integer only moves when someone remembers, and until that was fixed a reworded prompt would have left pre-edit entries served for their full hour under the new spec _and_ stamped into the shadow table with the new hash, which is precisely the blend this rule exists to prevent.
6. **Reject unknown answer keys.** Every response parse rejects keys outside the question set, distributions must sum to ~1 (±0.02) over the offered options, scores/nouls must be in range. Confidence is never a permission slip: no resource is admitted or refused on one. A label row's `confidence` does gate whether that row is read for ORDERING (`RESOURCE_INSIGHT_MIN_CONFIDENCE`) — a row below the floor is treated as if the version were unlabeled, which changes rank and nothing else.
7. **Adversarial state.** The prompt is user text. The `injectionPresent` Noul is asked and logged; deterministic rules own every consequence. Jev's judgment never feeds back into state.
8. **No invariants across calls.** Full distributions are logged; nothing probabilistic is combined in code.

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

The role compiles to a ModelType filter (`ROLE_MODEL_TYPES` in the schema file — exhaustive, `none` → no matcher run, unknown → no filter). `role` and `styleFamily` are carried in criteria and are the two axes the label ordering compares against; `contentType`/`specificity` are recorded on the shadow event only. ⚠️ **None of them are given to stage 3** — that sentence used to say they were and it is false: stage 3's `state` is `{ prompt }` alone and `buildStage3Question`'s text carries only the shortlist. The code sends _less_ user-derived context than this doc claimed, which is benign in direction but misleading to the next fixer. They also do not yet filter the search — there is no normalized style taxonomy to filter on, and the study (M3) decides whether any mapping earns its false-exclusions.

## Caching, rate limits, flag

- **Cache:** full responses under `packed:caches:jev-resource-intent:v1:<sha256>`, TTL 1h. Degraded responses cache for 60s only — a transient vendor failure must not pin an empty result to a prompt for an hour.
- **Rate limit:** per-`blockInstanceId` LLM bucket (`:llm:` sub-namespace, 30 req/60s, fail-open) — a request is up to two vendor round trips, so it does not share the catalog bucket.
- **Flag:** `resourceIntentJev` in `feature-flags.service.ts` (`availability: []`, fliptKey `resource-intent-jev`). Flipt owns the decision; an unknown flag or unreachable Flipt denies. The flag is checked **before** the cache read — a dark endpoint never reads and never spends. The Flipt flag definition itself is a separate flipt-state change and must ship default-OFF.

## Label ordering

`ResourceInsight` holds one meaning/quality row per labeled model version
(`role`, `styleFamily`, `contentTypes`, `qualityScore`, `confidence`, `specHash`,
`stale`), written offline by `scripts/label-resource-insights.ts`. The matcher
reads it to order the shortlist.

**What it orders, and what it does not.** The candidate pool still comes from a
popularity-seeded index query, because no insight field is projected into
`models_v9` — doing that needs a schema addition to the index plus a full reindex.
So this ranks within a popularity-seeded pool; it is not purpose-first retrieval.
The pool is deliberately **twice** the response cap so the ordering can promote a
candidate popularity placed outside the response, rather than only reshuffling the
visible page. The seed reaches `applyInsightRanking` only as the tiebreak index, so
replacing it later is a change to `searchShortlistModels` alone.

**Three buckets, not a score.** Only a small fraction of eligible versions carry a
row, and the labeled set is the high-usage head of the catalogue — so insight
coverage correlates with popularity, which anyone grading label ordering against a
popularity baseline has to control for. The policy:

| Candidate | Bucket |
| --- | --- |
| label agrees on role and style family | promote (3) |
| label agrees on role only | promote (2) |
| label agrees on style family only | promote (1) |
| no row, or `confidence` below the floor | neutral (0) — seed order preserved |
| confident label agreeing on neither axis | demote (−1) |

Nothing is dropped: the shortlist is a permutation of the pool. An unlabeled
candidate sits **above** a confident disagreement and **below** a confirmed
agreement; it is never scored as a zero, which would bury the unlabeled majority
under any weakly-labeled row. `qualityScore` separates candidates only inside one
bucket — there is no quality score to compare an unlabeled candidate against.

Two details that are decisions, not oversights: a `styleFamily` of `other` means
"none of the above" on both sides, so `other` ↔ `other` is not counted as
agreement; and `stale` rows (written under a superseded label spec, queued for a
re-label) are excluded at the read rather than scored down.

`contentTypes` is **not** read. The v1 label spec asks a singular single-`choice`
question and wraps the answer in a one-element array, so the column has one value
per row and its modal value is the catch-all — there is nothing to rank on until
the question becomes multi-select.

An unreachable label table costs the ordering and nothing else: the matcher logs
`resource-intent-insight-read-failed` and returns the seed order, rather than
taking the whole response down to `degraded: true`.

### Still not in this change: the M3 study

The offline gold-set study was built with an earlier draft and removed before
merge, along with the first attempt at this seam. It is parked on
`zach/jev-resource-intent-m2m3-parked` and should land with the decision it feeds
(M5's operating point), not before.

## Rollout

- **M1:** primitive + REST surface, dark behind `resourceIntentJev`.
- **M2:** `ResourceInsight` + the labeling script, then the matcher ordering that reads them. Done. **The index seed is NOT part of it** — putting an insight field in `modelsSortableAttributes` and reindexing is separate, larger work, and until it happens the pool is popularity-seeded.
- **M3 (not implemented):** the gold-set study. See the section above.
- **M4 (suggestions UI)** — NOT implemented. Closing condition: M1 merged + shadow volume ≥1k/day for 7 days + p95 end-to-end ≤2s.
- **M5 (auto-attach)** — NOT implemented, and never before BOTH: the threshold study shows per-slice precision ≥0.9 at the chosen operating point AND ≥2 weeks of live shadow agreement ≥80%.

## Verification

Unit suites (fixture-based, no external calls):

- `src/server/services/ai/__tests__/jev.test.ts` — fail-closed parsing, model pin, timeout.
- `src/server/services/__tests__/resource-intent-matcher.service.test.ts` — gates, determinism, cap, the label ordering and its confidence floor.
- `src/server/services/__tests__/resource-intent.service.test.ts` — cache, degradation, stage flow.
- `src/server/services/__tests__/resource-intent-insight-rerank.test.ts` — the service and the REAL matcher together: a label changes the order of a served response. The two suites above each mock the other side, so neither can see that.
- `src/server/__tests__/blocks/resource-intent.endpoint.test.ts` — auth/clamp mirror, deny-before-spend.
