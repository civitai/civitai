# Resource-intent primitive (Jev)

**Status:** **M1 + the M2 consume seam** — the primitive and its REST surface, dark behind `resourceIntentJev` (default-deny), with the shortlist now ordered against the `ResourceInsight` labels. The candidate POOL is seeded by the requested PURPOSE first — models whose projected `insight.role` matches the request, best `insight.qualityScore` first — and filled by popularity; see [Label ordering](#label-ordering) for what that does and does not buy, and [Rollout](#rollout) for the index precondition it carries. M3 (the gold-set study) is committed but has never been run; it grades stage-1 agreement AND carries a pre-registered two-arm retrieval comparison (the purpose-first matcher against the popularity seed alone) — see [The M3 study](#the-m3-study-a-pre-registered-retrieval-comparison-never-run). M4/M5 are gated follow-ons — see [Rollout](#rollout).

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
  → matcher: Meilisearch models_v9 filtered; purpose page (insight.role) + popularity page, merged
      → version pool ≤ 2 x cap
      → ordered against ResourceInsight via `dbRead` (the Postgres read replica)
      → shortlist ≤ min(limit||50, 255) versions
  → Jev request #2: one Choice over the shortlist, `none` fallback
  → response {intent, criteria, suggestions[], model, criteriaVersion, insightFallback}
  → shadow event → ClickHouse resourceIntentShadow   (graceful fallback to structured log)
```

| File                                                     | Role                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/services/ai/jev.ts`                          | Vendor seam. Pinned model, fail-closed validation, 2s timeout.                                                                      |
| `src/server/schema/resource-intent.schema.ts`            | Question spec v1, criteria schema, role→ModelType mapping, spec hash.                                                               |
| `src/server/services/resource-intent.service.ts`         | Cache → stage 1 → criteria → matcher → stage 3 → hydration → shadow event. Plain async function; reusable without the REST surface. |
| `src/server/services/resource-intent-stage1.ts`          | Stage 1 as pure functions (request, answer parse, criteria compile), shared by the service and the M3 study. Imports only the schema and a jev type, so a standalone script can load it. |
| `src/server/services/resource-intent-matcher.service.ts` | Deterministic gates + purpose-then-popularity seeded pool + `ResourceInsight` ordering + hard cap.                                  |
| `src/pages/api/v1/blocks/resource-intent.ts`             | Block-token REST surface.                                                                                                           |
| `scripts/label-resource-insights.ts`                     | The offline batch pass that WRITES `ResourceInsight`, and enqueues the labeled MODELS for reindex. Run manually; spends vendor budget on every invocation, dry run included. |
| `scripts/eval-resource-intent-goldset.ts`                | M3 gold-set study runner. Committed, never executed; no-ops without `--execute`. Samples the gold and grades stage-1 agreement, then runs the retrieval comparison below. |
| `scripts/eval-resource-intent-retrieval.ts`              | M3 two-arm retrieval comparison: the PURPOSE and POPULARITY arms, the metric math (hit@K, MRR, exact McNemar), the MET / NOT MET / VOID verdict and its report. |
| `scripts/eval-resource-intent-registration.ts`           | M3's registration: the pre-registered constants and text, and the committed gold-set queries. No database or search client, so the dry run is hermetic. |
| `scripts/eval-resource-intent-goldset-execute.ts`         | The `--execute` half of the runner (replica, index, vendor), loaded only under `--execute`. |

## Hard rules

1. **Pin the model.** `typesafe/jev-1.13` (numbered). `jev-latest` never appears in code. ⚠️ **This rule used to read "the client sends `allowFallbacks: false`, so OpenRouter cannot route the call to a different model while we record ours", and that is RETRACTED** — it described the chat/completions transport, which could never have worked at all (see the transport note below). The decisions endpoint's only proven request shape is `{model, state, questions}`, and sending an unverified `provider` key to a strictly-validated alpha endpoint is how the original defect happened. The pin is now enforced on the **response** instead: the vendor reports the build that answered (`typesafe/jev-1.13-20260917` for the pinned `typesafe/jev-1.13`), `askJev` fails closed on anything that is not the pin or a dated build of it, and `JevResponse.model` carries that vendor-reported build rather than our constant. That observes what actually ran instead of requesting a routing promise.
2. **Fail closed, fail empty.** Any Jev error/timeout/malformed response returns HTTP 200 with `degraded: true` and `suggestions: []`. Never a stack trace, never fabricated suggestions. 🔴 A **label**-read failure is deliberately NOT a degrade: on its own it produces a complete response with a real intent and real suggestions, flagged `insightFallback: true`, and `degraded` keeps meaning "the vendor path failed" so the invariants above (`suggestions: []`, `intent`/`criteria` `null`, `model: 'jev-unavailable'`) stay true of every degraded row. ⚠️ The two are not exclusive: a label read can fail and a LATER stage degrade anyway, giving `degraded: true` **with** `insightFallback: true` and no suggestions — so `insightFallback` is only interpretable when `degraded` is false. Both take a short cache TTL, for different reasons — see [Caching](#caching-rate-limits-flag).
3. **Deterministic gates always win.** Availability (no Private), the token's `maxBrowsingLevel` maturity clamp (authoritative — no client maturity field is read), region restriction, canGenerate coverage, baseModel compatibility (caller-supplied, never Jev output), and the hard-coded `celebrity` tag exclusion are applied in the matcher. Hydration re-checks exactly TWO of them — `hasAccess` and the maturity ceiling. Coverage, baseModel and the celebrity exclusion are NOT re-checked there, and `canGenerate` is present on the hydrated resource and unread. ⚠️ **No principle separates the two re-checked gates from the three that are not.** An earlier draft of this line said the re-checked ones are "the ones whose indexed value can lag"; that is false — the source comment beside the check says the _coverage_ filter is a superset that can lag, and coverage is gated on indexed Meili fields exactly like the rest. So the honest statement is that a version whose coverage lapsed since the last index build can still be suggested. Treat that as an accepted gap with no stated justification, not as a designed boundary — and if you close it, `canGenerate` is already on the object. Jev output can only reorder/drop within the gate-passing set, never add — the stage-3 option list contains exactly the shortlisted keys plus `none`, so an unknown version is unrepresentable.
4. **`none` is a first-class answer.** Stage-1 `role` includes `none`; stage 3 includes `none`. An argmax of `none` returns empty suggestions _without_ `degraded`.
5. **Stable question IDs + spec hash.** `QUESTION_SPEC_VERSION` plus a sha256 over the question spec ride every response and shadow row; a question edit invalidates old analytics instead of blending with them. 🔴 **The spec term in the CACHE KEY is the hash, not the version** — the hash moves on any spec edit, the hand-maintained integer only moves when someone remembers, and until that was fixed a reworded prompt would have left pre-edit entries served for their full hour under the new spec _and_ stamped into the shadow table with the new hash, which is precisely the blend this rule exists to prevent.
6. **Reject unknown answer keys.** Every response parse rejects keys outside the question set, distributions must sum to ~1 (±0.02) over the offered options, scores/nouls must be in range. Confidence is never a permission slip: no resource is admitted or refused on one. A label row's `confidence` does gate whether that row is read for ORDERING — against `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` on the promote side and `RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE` on the demote side, **two constants holding the same value today** — and a row below the floor for its direction is treated as if the version were unlabeled. The precise claim is that **no deterministic gate is applied or relaxed on a confidence**: no filter, drop or maturity decision reads it. It is NOT the weaker-sounding "changes rank and nothing else", because the shortlist is a fixed-width page cut out of a wider pool, so rank decides admission to the response.
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

The role compiles to a ModelType filter (`ROLE_MODEL_TYPES` in the schema file — exhaustive, `none` → no matcher run, unknown → no filter). `role` and `styleFamily` are carried in criteria and are the two axes the label ordering compares against; `contentType`/`specificity` are recorded on the shadow event only. ⚠️ **None of them are given to stage 3** — that sentence used to say they were and it is false: stage 3's `state` is `{ prompt }` alone and `buildStage3Question`'s text carries only the shortlist. The code sends _less_ user-derived context than this doc claimed, which is benign in direction but misleading to the next fixer. They also do not yet filter the search — the search index carries no normalized style attribute to filter on (a style taxonomy does exist, in `ResourceInsight`, and the label ordering reads it), and whether any mapping earns its false-exclusions is for a future study — neither part of M3 tests a filter mapping.

## Caching, rate limits, flag

- **Cache:** full responses under `packed:caches:jev-resource-intent:v1:<sha256>`, TTL 1h. Degraded responses cache for 60s only — a transient vendor failure must not pin an empty result to a prompt for an hour. **A label-read fallback (`insightFallback: true`) takes 60s too**, via its *own* constant `INSIGHT_FALLBACK_CACHE_TTL_SECONDS`: an unordered response must not be pinned for an hour while the analogous vendor failure gets a minute. The flag rides inside the cached blob, so a replay reports what the computation did rather than a fresh `false`.
- 🔴 **The two short TTLs are separate constants at the same value, because their RETRY COSTS are not alike** and a TTL buys retry cost, not response quality. The label read sits *between* the two Jev round trips, so a fallback miss has already paid stage 1 and goes on to pay stage 3 in full — two billed vendor calls plus the search query and hydration — where the dominant degraded case (stage-1 Jev throwing) costs one abandoned call and nothing downstream. The benefit inverts as well: a degraded response is useless so a fast retry is worth paying for, while a fallback response is fully usable and merely unranked. **Consequence to weigh before opening the flag:** against a *recurring* fault a repeated prompt re-runs the whole pipeline up to 60× per hour instead of once, and one trigger is not transient at all — an unapplied `ResourceInsight` migration is one of M2's operational preconditions and is the default state of a fresh environment. Two things that would make this measurable rather than reasoned do not exist yet: no shadow column or metric for the state (only a fire-and-forget log), and no single-flight around the cache's compute. The value is deliberately left at 60s and un-jittered — those are judgments for whoever opens the flag.
- **Rate limit:** per-`blockInstanceId` LLM bucket (`:llm:` sub-namespace, 30 req/60s, fail-open) — a request is up to two vendor round trips, so it does not share the catalog bucket.
- **Flag:** `resourceIntentJev` in `feature-flags.service.ts` (`availability: []`, fliptKey `resource-intent-jev`). Flipt owns the decision; an unknown flag or unreachable Flipt denies. The flag is checked **before** the cache read — a dark endpoint never reads and never spends. The Flipt flag definition itself is a separate flipt-state change and must ship default-OFF.

## Label ordering

`ResourceInsight` holds one meaning/quality row per labeled model version
(`role`, `styleFamily`, `contentTypes`, `qualityScore`, `confidence`, `specHash`,
`stale`), written offline by `scripts/label-resource-insights.ts`. The matcher
reads it to order the shortlist.

**What it orders, and what seeds it.** The ordering permutes a candidate pool that
`searchShortlistModels` seeds from up to two index pages over the same gate filter: a
PURPOSE page (the filter AND `insight.role = <requested role>`, sorted
`insight.qualityScore:desc` then `metrics.thumbsUpCount:desc`) and, ONLY when that page
comes back short of the pool width, a POPULARITY page (the filter alone, sorted
`metrics.thumbsUpCount:desc`, at the full width because the merge drops models already
on the purpose page). They are merged purpose page first, deduped by model id, and
truncated to the pool width. A busy cell therefore costs one page; a role with few
labeled matches costs a second, sequential round trip.

Why two pages rather than one sort: a single quality-first sort with no role filter
ranked labeled models by quality regardless of purpose, and a busy type × baseModel cell
holds more labeled models than the pool is wide — one LoRA cell held ~1,265 `character`
labels against ~131 `clothing` (a facet over the production index, 2026-10-06) — so a
`clothing` request was seeded with a handful of clothing LoRAs among ~100 for other
purposes, and the ordering below can only permute what it is handed.

⚠️ **The purpose page cannot filter on label confidence.** The index carries the role of
each model's best-scoring version among those at or above the promote floor when the
document was written, not the confidence; projecting it means rewriting every document
(a full index reset). So a match at the bare floor is seeded exactly like a confident
one. And the pooled version is not always the one the role came from — another version
of the model (including one on a different base model, since the filter matches
`versions.baseModel` across all versions), a row re-labelled since, or a moved floor can
each reach the ordering with a label that disagrees or sits below the floor, where it is
treated like any other candidate. A version left NEUTRAL that way keeps its seed
position within the neutral bucket: an unlabeled version on the requested base model, of
a model whose role came from a version on another, sorts ahead of every unlabeled,
neutral or demoted fill candidate — but a fill version promoted on role or on style
family alone still outranks it.

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
finished, with every newly-labeled model carrying a null role and so missing the
purpose page — a defect whose symptom is indistinguishable from "the labels are bad". **Touching `Model.updatedAt` instead was considered and
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
promote a candidate the seed placed outside the response rather than only
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
popularity-ordered page runs **~30–45× the corpus rate**. Those figures were measured
before the purpose-first seed and describe its popularity page only; the purpose page
is labeled by construction (every model on it matched a projected role), though a
matched model's other versions may carry no row:

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
evicted may be an unlabeled candidate. And the SEED excludes too: whenever the purpose
page is non-empty, its hits displace the least popular models a popularity-only pool
would have held — by design, since that displacement is the point of seeding by
purpose. What is bounded is the WIDTH: the merged pool is at most `poolCap` documents,
and a request fetches at most one page of `poolCap` when the purpose page is full, two
(≤ 2 × `poolCap` documents) when it is short. The two pages are sequential, so an index
that is slow but answering can hold the seed for up to 2 × `MEILI_RESOURCE_SELECT_TIMEOUT_MS`
(20s at the 10s default). Whether that width still fills the pool
under the purpose-first order has not been re-swept.

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
placed there moves nothing the caller sees while counting as actionable. A class
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

### The M3 study: a pre-registered retrieval comparison, never run

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
beating the popularity arm on its pre-registered metric"*. Per sampled prompt it runs
stage 1, then both arms with the same criteria, `browsingLevel`, coverage and cap.
PURPOSE is `findResourceIntentCandidates` itself. POPULARITY is the endpoint's own
popularity seed page, alone: its filter, pool width, baseModels and cap come from
`resolveResourceIntentSeedPlan`, its page from `buildResourceIntentSeedQueries`, its
fetch from `searchResourceIntentSeedPage`, and it is never handed to the label
re-rank. Neither arm calls stage 3.

**The pre-registration lives in code, not here:** `M3_RETRIEVAL_PREREGISTRATION` in
`scripts/eval-resource-intent-registration.ts`, rendered as text by
`renderRetrievalPreregistration()`. Read it by running the script without `--execute`
(`pnpm run tsscript scripts/eval-resource-intent-goldset.ts`), which prints the committed
queries and that text and exits 0. It still needs the server env to validate, but it
loads no database or search client, so it needs no Prisma engine, no database and no
index; every report opens with the same text. In
brief: the primary metric is hit@10; the decision rule is b > c AND exact two-sided
McNemar p < 0.05 on the hit@10 discordant pairs; and every run reports exactly one
verdict on the closing clause — **MET** (the rule holds), **NOT MET** (it does not: the
clause is judged not met, the question is closed as not delivered, and any follow-up
such as better gold or new labels is new work under a new registration, not a re-run of
this one) or **VOID** — the run is too degraded or too different to judge the clause: a
registered value was overridden, fewer than 667 prompts scored (the n the power
calculation assumes), infrastructure exclusions (stage-1 failures, arm errors, label-read
fallbacks) exceed 10% of drawn prompts, or both arms returned the same top 10 on every
scored prompt. VOID is checked before the decision rule, so a degraded run can never
produce a binding NOT MET (or MET). The labeled/unlabeled breakdown is
reported but never decisive.

**Run the pilot first.** Before the registered run, run
`--execute --retrieval-sample 100` — no new flags; the override stamps the report as not
the registered run, so its verdict is VOID by construction. Its report prints the two
rates the sample size was planned on: the scored fraction (assumed >= 66.7% of drawn
prompts) and the hit@10 discordant rate, (b + c) / scored (assumed >= 15%), and flags
either one that falls below. If the discordant rate is under 15%, re-plan the sample size
BEFORE the registered run: change the registered values only in a new commit dated
before that run, and say why in it.

**Coverage must resolve as the endpoint's does, or the run does not happen.** Both arms
filter on generation coverage from `coverageAudience(undefined)`, which reads Flipt through
`isFlipt` — and `isFlipt` returns `false` both for a flag that is off and when Flipt is
unreachable, so an unreachable Flipt silently grades a filter the endpoint does not use.
`--execute` therefore initialises Flipt and requires a real evaluation (`isFliptSync` not
`null`) of both coverage flags before any index read or vendor call, aborting otherwise;
the report prints the resolved `{next, member}`. A finished `--execute` closes the Flipt
client and the replica connection and exits explicitly (an earlier run hung on an open
handle after writing its report).

**The pilot, and registration v2.** The first pilot (2026-10-06) ran on flag defaults
for exactly this reason and was discarded. The corrected pilot (2026-10-06, Flipt
reachable, coverage resolved live) measured 85.0% scored and a 17.6% hit@10 discordant
rate — both meet the registered power assumption, so the sample size (1000) and both VOID
floors (667 scored; 10% infrastructure) are unchanged. At those rates ~150 discordant
pairs are expected, and power against the 65/35 alternative is 0.955. The pilot's
direction played no part in any choice. Registration v2 differs from v1 only in the
flag-evaluation abort, the coverage line in the report, and its History text, which
records both pilots.

The positive control reads the field the PURPOSE page filters on. Without it, an index
whose projection had failed wholesale would turn PURPOSE into POPULARITY and the study
into a quiet "no difference". The report also counts the scored prompts where both
arms returned the same first K model ids; if that is every one of them, the arms are
indistinguishable at K (the purpose page returned nothing, or the label re-rank never
moved the head) and the run is void rather than null.

What it does NOT do: it is offline, so it grades the ordering on a past corpus and
writes nothing to `resourceIntentShadow` — the shadow-table closing condition above is
untouched by it. And attached-resource gold is biased toward popular models, the
confound the pre-registration states.

## Rollout

- **M1:** primitive + REST surface, dark behind `resourceIntentJev`.
- **M2:** `ResourceInsight` + the labeling script, then the matcher ordering that reads them. Code done. 🔴 **Two OPERATIONAL preconditions are not, and neither is automatic:** `packages/civitai-db-schema/prisma/migrations/20260929170000_resource_insights/migration.sql` is applied by hand per environment, and `scripts/label-resource-insights.ts` must have been run there. Until both hold in a given environment the ordering is wired but has nothing to read, which is a data state, not a code state — and the two are distinguishable from outside: an unapplied migration makes the read FAIL, so the matcher logs `resource-intent-insight-read-failed`, sets `insightFallback: true` and the response caches for 60s; an unrun labelling pass makes the read SUCCEED and return nothing, which is `insightFallback: false` on the full-hour TTL and silently preserves the seed order. An environment stuck on the second therefore looks healthy, by design. **The index seed** — `insight.qualityScore`, `insight.role` and `insight.styleFamily` are projected by the models index; the score is in `modelsSortableAttributes` and all three in `modelsFilterableAttributes`. 🔴 It carries an operational precondition of the same kind as the two above, and it is likewise not automatic: the purpose page SORTS on `insight.qualityScore` and FILTERS on `insight.role`, so an index whose settings lack either rejects that page, and the matcher fails the whole seed rather than falling back to the popularity page alone. The sortable list reaches a live index only via a manual full reset; the filterable list also via `src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts`. Checked 2026-10-06: the production models index carries both (and `insight.styleFamily` filterable), and the purpose-page query shape returned results there without error. Other environments may differ — check both settings on the target index before opening the flag there.
- **M3 (committed, never run):** the gold-set study — stage-1 agreement, plus the pre-registered two-arm retrieval comparison that grades the resource-meaning layer's last closing clause, quoted in that section. Run it only once the purpose-first seed serves from a `release` build; the decision rule is fixed in [The M3 study](#the-m3-study-a-pre-registered-retrieval-comparison-never-run).
- **M4 (suggestions UI)** — NOT implemented. Closing condition: M1 merged + shadow volume ≥1k/day for 7 days + p95 end-to-end ≤2s.
  🔴 **The p95 half of that condition moves under a label-read fault, and no shadow column records why.** In an environment where the `ResourceInsight` migration is unapplied — which this doc elsewhere calls the default state of a fresh environment — a label read that is *issued* fails, so those responses take the 60s fallback TTL instead of the 1h success TTL, and per-key recomputes rise to **up to** 60/hour, each paying two vendor round trips plus search plus hydration. Because `writeShadowEvent` fires on cache hits too, the shadow population's miss share rises and its `latencyMs` p95 rises with it. **Do not read a p95 regression as an M4 failure without first checking that the label read is succeeding in that environment**; the shadow table cannot distinguish the two.
  ⚠️ **The volume half is NOT affected, and the clause above is the reason:** the shadow write is unconditional, so rows/day tracks calls/day and is invariant to the miss rate. A volume reading stays trustworthy under this fault — do not discount it.
  ⚠️ **And the 60s signature is absent for two response classes, so its absence does not prove the migration is applied.** A `role: 'none'` answer short-circuits before the matcher runs, and an empty pool skips the label read entirely (it returns before touching the database — this branch's own test pins that as "NOT a fallback: the read did not fail, it never happened"). Both keep the 1h TTL with `insightFallback: false`. A fresh environment is at least as likely to have an unseeded search index as an unapplied migration, and the two unseeded states differ: an index whose SETTINGS lack `insight.role` (filterable) or `insight.qualityScore` (sortable) fails the seed outright, so the response degrades and takes the 60s degraded TTL; settings applied but documents not yet rewritten leaves the purpose page empty, the popularity page fills the pool, and every response takes the hour.
- **M5 (auto-attach)** — NOT implemented, and never before BOTH: the threshold study shows per-slice precision ≥0.9 at the chosen operating point AND ≥2 weeks of live shadow agreement ≥80%.

## Verification

Unit suites (fixture-based, no external calls):

- `src/server/services/ai/__tests__/jev.test.ts` — fail-closed parsing, model pin, timeout.
- `src/server/services/__tests__/resource-intent-matcher.service.test.ts` — gates, determinism, cap, the label ordering, its two confidence floors, and the label-read fallback it reports.
- `src/server/services/__tests__/resource-intent.service.test.ts` — cache, degradation, stage flow, the fallback's cache TTL.
- `src/server/services/__tests__/resource-intent-insight-rerank.test.ts` — the service and the REAL matcher together: a label changes the order of a served response, and a label-read failure takes the 60s TTL rather than the hour. The two suites above each mock the other side, so neither can see either of those.
- `src/server/__tests__/blocks/resource-intent.endpoint.test.ts` — auth/clamp mirror, deny-before-spend.
- `scripts/__tests__/eval-resource-intent-goldset.tsx-smoke.test.ts` — spawns the gold-set script under `tsx` (the real entry point) and checks, from a module-load trace, that the dry run loads neither the database nor the search client (on any host), and that it prints its queries and the pre-registration and exits 0 with every `PRISMA_*` variable removed. The in-process suites cannot see a load-time import cycle; this can.
- `scripts/__tests__/eval-resource-intent-retrieval.test.ts` — the M3 retrieval metric math against literal values, the verdict mapping, the pre-registration constants, both arms over an in-memory index, and the CLI gate.
