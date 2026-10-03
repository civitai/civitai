# Resource-intent primitive (Jev)

**Status:** **M1 + the M2 consume seam** — the primitive and its REST surface, dark behind `resourceIntentJev` (default-deny), with the shortlist now ordered against the `ResourceInsight` labels. The candidate POOL is still seeded by popularity; see [Label ordering](#label-ordering) for what that does and does not buy. M3 (the gold-set study) is committed but has never been run, and grades stage-1 agreement rather than retrieval — see [Label ordering](#label-ordering). M4/M5 are gated follow-ons — see [Rollout](#rollout).

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
| `scripts/eval-resource-intent-goldset.ts`                | M3 gold-set study runner. Committed, never executed; no-ops without `--execute`. Grades stage-1 agreement, not retrieval.            |

## Hard rules

1. **Pin the model.** `typesafe/jev-1.13` (numbered). `jev-latest` never appears in code. ⚠️ **This rule used to read "the client sends `allowFallbacks: false`, so OpenRouter cannot route the call to a different model while we record ours", and that is RETRACTED** — it described the chat/completions transport, which could never have worked at all (see the transport note below). The decisions endpoint's only proven request shape is `{model, state, questions}`, and sending an unverified `provider` key to a strictly-validated alpha endpoint is how the original defect happened. The pin is now enforced on the **response** instead: the vendor reports the build that answered (`typesafe/jev-1.13-20260917` for the pinned `typesafe/jev-1.13`), `askJev` fails closed on anything that is not the pin or a dated build of it, and `JevResponse.model` carries that vendor-reported build rather than our constant. That observes what actually ran instead of requesting a routing promise.
2. **Fail closed, fail empty.** Any Jev error/timeout/malformed response returns HTTP 200 with `degraded: true` and `suggestions: []`. Never a stack trace, never fabricated suggestions.
3. **Deterministic gates always win.** Availability (no Private), the token's `maxBrowsingLevel` maturity clamp (authoritative — no client maturity field is read), region restriction, canGenerate coverage, baseModel compatibility (caller-supplied, never Jev output), and the hard-coded `celebrity` tag exclusion are applied in the matcher. Hydration re-checks exactly TWO of them — `hasAccess` and the maturity ceiling. Coverage, baseModel and the celebrity exclusion are NOT re-checked there, and `canGenerate` is present on the hydrated resource and unread. ⚠️ **No principle separates the two re-checked gates from the three that are not.** An earlier draft of this line said the re-checked ones are "the ones whose indexed value can lag"; that is false — the source comment beside the check says the _coverage_ filter is a superset that can lag, and coverage is gated on indexed Meili fields exactly like the rest. So the honest statement is that a version whose coverage lapsed since the last index build can still be suggested. Treat that as an accepted gap with no stated justification, not as a designed boundary — and if you close it, `canGenerate` is already on the object. Jev output can only reorder/drop within the gate-passing set, never add — the stage-3 option list contains exactly the shortlisted keys plus `none`, so an unknown version is unrepresentable.
4. **`none` is a first-class answer.** Stage-1 `role` includes `none`; stage 3 includes `none`. An argmax of `none` returns empty suggestions _without_ `degraded`.
5. **Stable question IDs + spec hash.** `QUESTION_SPEC_VERSION` plus a sha256 over the question spec ride every response and shadow row; a question edit invalidates old analytics instead of blending with them. 🔴 **The spec term in the CACHE KEY is the hash, not the version** — the hash moves on any spec edit, the hand-maintained integer only moves when someone remembers, and until that was fixed a reworded prompt would have left pre-edit entries served for their full hour under the new spec _and_ stamped into the shadow table with the new hash, which is precisely the blend this rule exists to prevent.
6. **Reject unknown answer keys.** Every response parse rejects keys outside the question set, distributions must sum to ~1 (±0.02) over the offered options, scores/nouls must be in range. Confidence is never a permission slip: no resource is admitted or refused on one. A label row's `confidence` does gate whether that row is read for ORDERING (`RESOURCE_INSIGHT_MIN_CONFIDENCE`) — a row below the floor is treated as if the version were unlabeled. The precise claim is that **no deterministic gate is applied or relaxed on a confidence**: it is read at exactly one site, and no filter, drop or maturity decision reads it. It is NOT the weaker-sounding "changes rank and nothing else", because the shortlist is a fixed-width page cut out of a wider pool, so rank decides admission to the response.
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
The seed reaches `applyInsightRanking` only as the tiebreak index, so replacing it
later is a change to `searchShortlistModels` alone.

The pool is wider than the response — `min(cap × 2, 255)` — so the ordering can
promote a candidate popularity placed outside the response rather than only
reshuffling the visible page. 🔴 Read that bound literally: the widening shrinks
from `cap = 128` and is **1× at the maximum accepted `limit` of 255**, where the
ordering really can only reshuffle the visible page. It is the default cap of 50
that gets a 2× pool.

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

Nothing is FILTERED: an absent label never disqualifies a candidate, and the
ordering is a permutation of the pool. An unlabeled candidate sits **above** a
confident disagreement and **below** a confirmed agreement; it is never scored as a
zero, which would bury the unlabeled majority under any weakly-labeled row.
`qualityScore` separates candidates only inside one bucket — there is no quality
score to compare an unlabeled candidate against.

🔴 But the permutation is then **sliced to the response cap**, so on a pool wider
than the cap the ordering decides *which* resources are suggested, not only their
order — a promotion into a fixed-width page is an eviction out of it, and what gets
evicted may be an unlabeled candidate. Relative to the popularity-only behaviour
this replaces, no candidate is excluded that the old pool would have contained; but
"nothing is dropped" would be the wrong way to read the table above.

Three details that are decisions, not oversights.

**`other` is not agreement.** A `styleFamily` of `other` means "none of the above"
on both sides, so `other` ↔ `other` does not count. Consequence worth knowing: for
a request whose compiled `styleFamily` is `other`, the style axis is dead and the
"agrees on style family only" row of the table above is unreachable — that slice
degrades to role-only.

**The confidence floor is a four-axis minimum.** `ResourceInsight.confidence` is
the weakest of a row's four label judgments, `contentType` included — the axis the
ordering never reads. So a row can fall below the floor on the confidence of a
question this design calls unusable. Only the aggregate is persisted, so nothing
here can separate them.

**`stale` is a floor, not a freshness guarantee.** Nothing in this repo sets
`stale = true` — the migration describes that flip as a manual step of a label-spec
bump — so the clause excludes no row today, and `specHash` is deliberately not
compared: filtering on it would make the ordering inert from the moment a spec
moves until a vendor-spend-gated re-label pass finished, and the table was designed
so superseded rows stay readable. (`specHash` holds the LABEL spec's hash, which
lives in `scripts/label-resource-insights.ts`, so comparing it would also make a
server service depend on a CLI script.) What protects a superseded row from doing
harm is the demotion rule instead: **demotion turns on the `role` alone, and only
on a role this build recognises.** A taxonomy edit supersedes every row's spec *and*
makes its strings unmatchable in one move, so demoting on a value nobody can
interpret would bury the whole labeled population beneath the unlabeled majority.
Note what that does and does not say: an unrecognised `styleFamily` beside a
recognised *disagreeing* role still demotes, because the role is the evidence. The
residual, resolved either by the manual `stale` flip or by re-running the labeling
pass: a spec that keeps an option's spelling and changes its meaning.

`contentTypes` is **not** read. The v1 label spec asks a singular single-`choice`
question and wraps the answer in a one-element array, so the column has one value
per row and its modal value is the catch-all — there is nothing to rank on until
the question becomes multi-select.

An unreachable label table costs the ordering and nothing else: the matcher logs
`resource-intent-insight-read-failed` and returns the seed order, rather than
taking the whole response down to `degraded: true`.

🔴 **The shadow table cannot see any of this, and that gap has to close before
M4/M5 read it.** `ShadowEvent` records no insight field, so a row produced by the
fallback above — cached for the full hour as `degraded: false` — is indistinguishable
from one whose pool simply held no labeled version, which is in turn indistinguishable
from one the labels reordered. Grading "do the labels help" against that corpus is
not possible. Harmless today only because the endpoint is dark.

Two things make the obvious fix insufficient, so the closing condition has to name
them. (a) `writeShadowEvent` fires on every call **including cache hits**, where the
matcher never ran — which is why `shortlistCount` is already reconstructed from the
response rather than left at 0. So a fallback-ordered response emits one marked row
and then up to an hour of unmarked ones unless the fields ride **inside the cached
blob**, i.e. in `resourceIntentResponseSchema`, which is itself another
cache-invalidating shape bump. (b) A pooled label count cannot separate "the labels
reordered this" from "every label landed neutral" — below the floor or unrecognised,
both of which this design makes deliberately common. That needs a reorder signal, not
a population count.

**Closing condition:** columns ON the `resourceIntentShadow` table carrying (i) the
count of pooled rows that reached a non-neutral bucket and (ii) whether the ordering
ran at all, both carried in the cached response so a replay reports the same values
as the computation, verified by a query that returns a non-empty, disjoint partition
of rows into reordered / ordering-ran-but-all-neutral / ordering-did-not-run.

### The M3 study exists, has never been run, and does not grade this

`scripts/eval-resource-intent-goldset.ts` is committed and its own header says so:
without `--execute` it prints its queries and exits, and a live run needs a
replica read plus a vendor key. ⚠️ An earlier version of this section said the
study had been "removed before merge" and was "parked on a branch" — that was
wrong in the direction that wastes someone's day, since the runnable evaluator
was in the tree the whole time.

What it measures is **stage-1 agreement** against the provenance corpus (role vs
the resource types a prompt actually attached, `needsResource` calibration,
review-rate curves). That is not the arm the parent arc's closing condition names
— "a purpose-query arm beating the popularity arm" needs a retrieval comparison,
which neither this evaluator nor this change provides.

## Rollout

- **M1:** primitive + REST surface, dark behind `resourceIntentJev`.
- **M2:** `ResourceInsight` + the labeling script, then the matcher ordering that reads them. Code done. 🔴 **Two OPERATIONAL preconditions are not, and neither is automatic:** `packages/civitai-db-schema/prisma/migrations/20260929170000_resource_insights/migration.sql` is applied by hand per environment, and `scripts/label-resource-insights.ts` must have been run there. Until both hold in a given environment the ordering is wired but has nothing to read, which is a data state, not a code state — the matcher logs `resource-intent-insight-read-failed` for the first and silently preserves the seed order for the second. **The index seed is NOT part of M2 either** — putting an insight field in `modelsSortableAttributes` and reindexing is separate, larger work, and until it happens the pool is popularity-seeded.
- **M3 (committed, never run):** the gold-set study. It does NOT grade clause (iii) above. See the section above.
- **M4 (suggestions UI)** — NOT implemented. Closing condition: M1 merged + shadow volume ≥1k/day for 7 days + p95 end-to-end ≤2s.
- **M5 (auto-attach)** — NOT implemented, and never before BOTH: the threshold study shows per-slice precision ≥0.9 at the chosen operating point AND ≥2 weeks of live shadow agreement ≥80%.

## Verification

Unit suites (fixture-based, no external calls):

- `src/server/services/ai/__tests__/jev.test.ts` — fail-closed parsing, model pin, timeout.
- `src/server/services/__tests__/resource-intent-matcher.service.test.ts` — gates, determinism, cap, the label ordering and its confidence floor.
- `src/server/services/__tests__/resource-intent.service.test.ts` — cache, degradation, stage flow.
- `src/server/services/__tests__/resource-intent-insight-rerank.test.ts` — the service and the REAL matcher together: a label changes the order of a served response. The two suites above each mock the other side, so neither can see that.
- `src/server/__tests__/blocks/resource-intent.endpoint.test.ts` — auth/clamp mirror, deny-before-spend.
