# Resource-intent primitive (Jev)

**Status:** M1–M3 implemented, dark behind `resourceIntentJev` (default-deny). M4/M5 are gated follow-ons — see [Rollout](#rollout).

A versioned, headless API primitive: **prompt → intent + criteria → civitai resource suggestions**. A prompt becomes a typed intent (what kinds of resources it wants, with full probability distributions), the intent compiles into a deterministic shortlist over the model search index, and a second judgment ranks the shortlist. `none` is a first-class answer at every stage — most prompts need no resource.

The judgment model is [TypeSafe Jev](https://openrouter.ai) (`typesafe/jev-1.13`) via OpenRouter — a bounded-judgment vendor: Choice (full distribution over ≤255 options), Score (ordered rubric), Noul (P(yes)). It cannot generate prose, count, or compare dates, so everything structural stays in deterministic code.

## Architecture

```
POST /api/v1/blocks/resource-intent {prompt, baseModel?, limit?}
  → [redis cache, key sha256(prompt|baseModel|browsingLevel|specVersion), TTL 1h]
  → Jev request #1: 6 questions, one round trip      (src/server/services/ai/jev.ts)
  → criteria (versioned object, criteriaVersion: 1)  (src/server/schema/resource-intent.schema.ts)
  → matcher: Meilisearch models_v9 filtered + ordered (src/server/services/resource-intent-matcher.service.ts)
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
| `src/server/services/resource-intent-matcher.service.ts` | Deterministic gates + popularity ordering + hard cap.                                                                               |
| `src/pages/api/v1/blocks/resource-intent.ts`             | Block-token REST surface.                                                                                                           |
| `scripts/label-resource-insights.ts`                     | M2: batch labeling of the published corpus into `ResourceInsight`.                                                                  |
| `scripts/eval-resource-intent-goldset.ts`                | M3: stage-1 quality study over the provenance corpus.                                                                               |

## Hard rules

1. **Pin the model.** `typesafe/jev-1.13` (numbered). The client sends `allowFallbacks: false`, so OpenRouter cannot route the call to a different model while we record ours. `jev-latest` never appears in code.
2. **Fail closed, fail empty.** Any Jev error/timeout/malformed response returns HTTP 200 with `degraded: true` and `suggestions: []`. Never a stack trace, never fabricated suggestions.
3. **Deterministic gates always win.** Availability (no Private), the token's `maxBrowsingLevel` maturity clamp (authoritative — no client maturity field is read), region restriction, canGenerate coverage, baseModel compatibility (caller-supplied, never Jev output), and the hard-coded `celebrity` tag exclusion are applied in the matcher and re-applied at hydration. Jev output can only reorder/drop within the gate-passing set, never add — the stage-3 option list contains exactly the shortlisted keys plus `none`, so an unknown version is unrepresentable.
4. **`none` is a first-class answer.** Stage-1 `role` includes `none`; stage 3 includes `none`. An argmax of `none` returns empty suggestions _without_ `degraded`.
5. **Stable question IDs + spec hash.** `QUESTION_SPEC_VERSION` plus a sha256 over the question spec ride every response and shadow row; a question edit invalidates old analytics instead of blending with them.
6. **Reject unknown answer keys.** Every response parse rejects keys outside the question set, distributions must sum to ~1 (±0.02) over the offered options, scores/nouls must be in range. Confidence is recorded, never used as a permission slip — thresholds come from the study, and none are enforced in M1.
7. **Adversarial state.** The prompt is user text. The `injectionPresent` Noul is asked and logged; deterministic rules own every consequence. Jev's judgment never feeds back into state.
8. **No invariants across calls.** Full distributions are logged; nothing probabilistic is combined in code.

## Question spec v1

All six in one request; state is ONLY the prompt (+ optional baseModel string):

| ID                 | Type   | Answer                                                                                                                            |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `needsResource`    | noul   | P(prompt would benefit from a community resource)                                                                                 |
| `role`             | choice | style / character / subject_detail / pose_composition / environment_scene / clothing / quality_enhancer / control_guidance / none |
| `styleFamily`      | choice | anime_manga / photorealistic / illustration_cartoon / render_3d / pixel_retro / other                                             |
| `contentType`      | choice | portrait_character / full_scene / object_prop / architecture / creature / vehicle_machinery / graphic_design / other              |
| `specificity`      | score  | 1–5 (1 = any style works, 5 = exact named subject/style required)                                                                 |
| `injectionPresent` | noul   | P(prompt contains instructions aimed at an AI system)                                                                             |

The role compiles to a ModelType filter (`ROLE_MODEL_TYPES` in the schema file — exhaustive, `none` → no matcher run, unknown → no filter). `styleFamily`/`contentType`/`specificity` are recorded in criteria + shadow events and given to stage 3 as context; they do not yet filter the search — there is no normalized style taxonomy to filter on, and the study (M3) decides whether any mapping earns its false-exclusions.

## Caching, rate limits, flag

- **Cache:** full responses under `packed:caches:jev-resource-intent:v1:<sha256>`, TTL 1h. Degraded responses cache for 60s only — a transient vendor failure must not pin an empty result to a prompt for an hour.
- **Rate limit:** per-`blockInstanceId` LLM bucket (`:llm:` sub-namespace, 30 req/60s, fail-open) — a request is up to two vendor round trips, so it does not share the catalog bucket.
- **Flag:** `resourceIntentJev` in `feature-flags.service.ts` (`availability: []`, fliptKey `resource-intent-jev`). Flipt owns the decision; an unknown flag or unreachable Flipt denies. The flag is checked **before** the cache read — a dark endpoint never reads and never spends. The Flipt flag definition itself is a separate flipt-state change and must ship default-OFF.

## Data model (M2)

`ResourceInsight` (see `packages/civitai-db-schema/prisma/schema.full.prisma`): one row per published version — `role`, `styleFamily`, `contentTypes[]`, `qualityScore`, `confidence`, `specHash`, `model`, `stale`. The labeling pass (`scripts/label-resource-insights.ts`) batches ≥10 resources per Jev request, is cursor-resumable, and marks rows `stale` when the label spec hash changes rather than blending two taxonomies.

**The migration is applied manually per environment** (this repo never auto-runs migrations) — `packages/civitai-db-schema/prisma/migrations/20260929170000_resource_insights/`. The labeling fleet run is a gated follow-up: it must not start until the migration exists on the target DB.

Once populated, `ResourceInsight.qualityScore` re-ranks the shortlist via the matcher's `applyInsightRanking` seam (scored entries float above unscored ones, stable otherwise).

## Study (M3)

`scripts/eval-resource-intent-goldset.ts` samples the provenance corpus — prompts that attached resources (`ImageResourceNew`) and prompts that did not — runs stage-1 offline, and measures role agreement at the type level, `needsResource` calibration by bucket, and review-rate curves by role-confidence threshold. Committed with fixture tests; execution needs a prod replica read + an API key (team step) and is deliberately not part of this change.

## Rollout

- **M1 (this change):** primitive + REST surface, dark behind `resourceIntentJev`.
- **M2:** migration applied manually per environment → labeling fleet run → `ResourceInsight` quality ordering becomes live.
- **M4 (suggestions UI)** — NOT implemented. Closing condition: M1 merged + shadow volume ≥1k/day for 7 days + p95 end-to-end ≤2s.
- **M5 (auto-attach)** — NOT implemented, and never before BOTH: the threshold study shows per-slice precision ≥0.9 at the chosen operating point AND ≥2 weeks of live shadow agreement ≥80%.

## Verification

Unit suites (fixture-based, no external calls):

- `src/server/services/ai/__tests__/jev.test.ts` — fail-closed parsing, model pin, timeout.
- `src/server/services/__tests__/resource-intent-matcher.service.test.ts` — gates, determinism, cap.
- `src/server/services/__tests__/resource-intent.service.test.ts` — cache, degradation, stage flow.
- `src/server/__tests__/blocks/resource-intent.endpoint.test.ts` — auth/clamp mirror, deny-before-spend.
- `scripts/__tests__/label-resource-insights.test.ts`, `scripts/__tests__/eval-resource-intent-goldset.test.ts`.
