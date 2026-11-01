import { createHash } from 'crypto';

import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import {
  clampResourceIntentCap,
  RESOURCE_INTENT_CRITERIA_VERSION,
  RESOURCE_INTENT_DEFAULT_LIMIT,
  RESOURCE_INTENT_SPEC_HASH,
  QUESTION_SPEC_VERSION,
  RESOURCE_INTENT_HYBRID_HEAD_MODELS,
  resourceIntentResponseSchema,
  type ResourceIntentInput,
  type ResourceIntentResponse,
  type ResourceIntentSuggestion,
} from '~/server/schema/resource-intent.schema';
import { projectSafeGenerationResource } from '~/server/schema/blocks/generation-resource-projection';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { askJev, JEV_TIMEOUT_MS, JevError } from '~/server/services/ai/jev';
import { getResourceData } from '~/server/services/generation/generation.service';
import {
  CHECKPOINT_LIST_MODELS,
  RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
  type CheckpointArm,
} from '~/server/services/resource-intent-checkpoint';
import {
  findCheckpointCandidates,
  findPoolMergeCandidates,
  findResourceIntentCandidates,
  findRankedCandidates,
  V1_TAGS_LIST_MODELS,
  type ResourceIntentCoverage,
  type ResourceIntentShortlistEntry,
} from '~/server/services/resource-intent-matcher.service';
import {
  tagIndexSnapshotHolder,
  type ServedTagIndex,
  type TagIndexFallbackReason,
  type TagIndexServing,
} from '~/server/services/resource-intent-tags/holder';
import {
  gateEligibleEcosystems,
  modalityEligibleEcosystems,
  RESOURCE_INTENT_V1_GATE_SPEC_HASH,
  V1_TAGS_REQUEST_MEDIA_TYPE,
  v1ListBaseModelFilter,
} from '~/server/services/resource-intent-tags/gate';
import {
  scoreTagRequest,
  TAG_SCORE_PARAMS,
  type TagIndex,
  type TagKind,
  type TagRequest,
  type TagScoreResult,
} from '~/server/services/resource-intent-tags/score';
import { CHECKPOINT_ATTACH_BUILD_HASH } from '~/server/services/resource-intent-cooc/checkpoint-attach';
import {
  coocSnapshotHolder,
  coocStudySnapshots,
  type CoocFallbackReason,
  type CoocServing,
  type ServedCooc,
} from '~/server/services/resource-intent-cooc/holder';
import { rankCooc } from '~/server/services/resource-intent-cooc/score';
import {
  RESOURCE_INTENT_COOC_SPEC,
  RESOURCE_INTENT_COOC_SPEC_HASH,
} from '~/server/services/resource-intent-cooc/spec';
import { coocQueryTokens } from '~/server/services/resource-intent-cooc/tokenize';
import { RESOURCE_INTENT_POOL_MERGE_SPEC_HASH } from '~/server/services/resource-intent-pool-merge';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import {
  buildResourceIntentStage1Request,
  compileCriteria,
  parseResourceIntentStage1Answers,
} from '~/server/services/resource-intent-stage1';
import {
  buildStage3Question,
  buildStage3State,
  combineStage3Answers,
  mergeHybrid,
  RESOURCE_INTENT_STAGE3_SPEC_HASH,
  stage3Orders,
} from '~/server/services/resource-intent-stage3';
import { resourceExceedsCatalogCeiling } from '~/server/utils/block-catalog-maturity';

/**
 * Resource-intent primitive — cache → Jev stage 1 (intent/criteria) →
 * deterministic matcher → Jev stage 3 (two Choice calls over the shortlist,
 * averaged) → HYBRID_10 merge with the matcher's `basePool` → suggestions.
 *
 * Fail-closed, with ONE documented exception. A Jev error in any stage, a
 * stage-3 parse error, a hydration error, and a matcher error OTHER than the
 * `ResourceInsight` read all return `degraded: true` with empty suggestions and
 * no thrown error, so callers treat it as "no suggestion". The exception is the
 * label read: it is caught INSIDE the matcher and yields a response carrying
 * `insightFallback: true`, which is undegraded UNLESS a later stage then fails
 * (see below — the two flags are independent, and both can be true at once).
 * ⚠️ This sentence has now been wrong THREE times — as "ANY error in ANY
 * stage"; then as a narrower absolute that still swallowed the label read; then
 * as an absolute on the exception itself, claiming the label read always yields
 * an undegraded response. Each rewrite fixed the previous generalisation by
 * writing a new one. If you are about to reword it a fourth time: enumerate the
 * `catch` sites, do not generalise over them, and note the enumeration above
 * names the DEGRADING ones only — several other catches here swallow without
 * touching the degraded contract. Jev output only orders the stage-3 head. Every
 * suggestion, head or `basePool` fill, passed every gate (availability, maturity,
 * coverage, baseModel, celebrity) in deterministic code, and the stage-3 options are
 * positional keys into the shortlist, so Jev can never add a version.
 *
 * `none` is a first-class answer at stage 1: when the role argmax is `none`, the
 * response carries empty suggestions without being degraded — the model judged the
 * prompt needs no resource. Stage 3's `none` is reported (`noneProbability`)
 * and never empties the list: the arm screen measured that rule costing hit@10.
 *
 * Suggestions are `mergeHybrid`'s HYBRID_10 list (`resource-intent-stage3.ts`), or, on the
 * POOL_MERGE arm (`ctx.poolMerge` / study mode), the co-occurrence list merged with the same
 * popularity pool (`findPoolMergeCandidates`), with no stage 3. With no servable production
 * snapshot that arm serves the popularity pool alone, flagged `coocFallback`, for 60 s.
 *
 * A label-read failure is NOT a degrade: the matcher falls back to the seed (popularity)
 * order and reports it, and the response carries `insightFallback: true`
 * alongside its normal suggestions. The only thing that changes here is the cache
 * TTL — see `INSIGHT_FALLBACK_CACHE_TTL_SECONDS`, and
 * `resourceIntentResponseSchema` for why the flag is not `degraded`.
 *
 * ⚠️ `insightFallback: true` does NOT imply suggestions. A label read that fails
 * and is then followed by a stage-3 or hydration failure degrades like any other,
 * and the flag rides along on that empty response because it describes the
 * computation. Read it only when `degraded === false`.
 *
 * Exported as a plain async function so internal (tRPC) consumers reuse this
 * exact flow; the block REST endpoint adds auth/maturity/rate-limit around it.
 */

const CACHE_TTL_SECONDS = 60 * 60;
// Jev failures are often transient (vendor 5xx, timeout); caching a degraded
// response for the full hour would pin an empty result to the prompt, so
// degrades cache briefly — a retry window without hammering the vendor.
const DEGRADED_CACHE_TTL_SECONDS = 60;

/**
 * The same short window for a response whose LABEL read failed
 * (`insightFallback`) — a separate constant at the same value, so today's
 * behaviour is identical and the two can diverge later. This is the one site that
 * owns the "why" for both short TTLs; the comments elsewhere point here rather
 * than restating it.
 *
 * Why not just reuse `DEGRADED_CACHE_TTL_SECONDS`: the two paths look alike on
 * response QUALITY and are asymmetric on RETRY COST, which is what a TTL actually
 * buys. The label read sits BETWEEN stage 1 and stage 3, so an
 * `insightFallback` miss has already paid stage 1 and goes on to pay stage 3 in
 * full — three BILLED vendor calls, plus two Meilisearch queries (the seed page and `basePool`'s
 * 500-document page) and hydration. The
 * dominant degraded case is stage-1 Jev throwing, which costs ONE call and that
 * one abandoned, with no stage 3, no search and no hydration. The benefit axis
 * inverts too: a degraded response is useless, so retrying it fast is worth
 * paying for, while an `insightFallback` response is fully usable and merely
 * unranked.
 *
 * 🔴 So this value, applied to a RECURRING failure, is a real cost: a repeated
 * prompt re-runs the whole pipeline up to 60x per hour instead of once. And one
 * trigger is not transient at all — an unapplied `ResourceInsight` migration is
 * one of M2's two named operational preconditions, is the default state of a fresh
 * environment, and is indistinguishable here from a replica blip. Prod has the
 * rows; dev/stage/preview may not.
 *
 * Deliberately NOT raised, and NOT jittered: the audit that found the silent
 * fallback asked for the short TTL, and both of those are value judgments for
 * whoever opens the flag. ⚠️ Before that happens, note the two things that make
 * this measurable rather than merely reasoned, neither of which exists yet: the
 * state has no shadow column and no metric — only a fire-and-forget
 * `resource-intent-insight-read-failed` log — and this cache has no single-flight
 * around its compute, so the fraction of wall clock a key spends inside a
 * recomputable window rises by the same factor.
 */
const INSIGHT_FALLBACK_CACHE_TTL_SECONDS = 60;

/** A POOL_MERGE response served without a snapshot is retried as soon as one may have loaded. */
const COOC_FALLBACK_CACHE_TTL_SECONDS = 60;

/** A v1_tags response that fell back to the POOL_MERGE list, likewise. */
const V1_FALLBACK_CACHE_TTL_SECONDS = 60;

/**
 * The cache lifetime of a response, for both modes (checkpoint responses never carry
 * `insightFallback`, so the ladder is the same for them).
 *
 * Read off the RESPONSE, not the locals, so what is cached and what sets
 * its lifetime are the same two fields — including on a path that rebuilt
 * the response object. `degraded` is checked first because a degraded
 * response carries no suggestions whatever the label read did.
 * 🔴 THIS PRECEDENCE IS NOT PINNED BY ANY TEST, and while both constants
 * are 60 the swap is a SEMANTIC NO-OP — the two orderings agree on all
 * four (degraded, insightFallback) states, so no test anywhere can kill
 * it, and none covers the `degraded && insightFallback` state where the
 * order would start to matter. That overlap state IS reachable: a failed
 * label read followed by a later-stage failure produces it. So the moment
 * you give the two paths different values this ordering becomes
 * behaviourally load-bearing with no guard on it — pin it in the same
 * change that diverges them. (Same class as the promote/demote constant
 * swap the F1 test docstring discloses. The earlier mutation sweep on
 * this branch did not cover it; its own wording scoped itself to a re-run
 * after the fixes, so the gap is in what was swept, not in the claim.)
 */
function responseCacheTtl(response: ResourceIntentResponse): number {
  return response.degraded
    ? DEGRADED_CACHE_TTL_SECONDS
    : response.insightFallback
    ? INSIGHT_FALLBACK_CACHE_TTL_SECONDS
    : response.coocFallback
    ? COOC_FALLBACK_CACHE_TTL_SECONDS
    : response.v1Fallback
    ? V1_FALLBACK_CACHE_TTL_SECONDS
    : CACHE_TTL_SECONDS;
}

export type ResourceIntentArm = 'hybrid_10' | 'pool_merge' | 'v1_tags';

/** The snapshot term of a POOL_MERGE cache key when no snapshot is served. */
export const COOC_FALLBACK_SNAPSHOT_KEY = 'fallback';

const DEGRADED_MODEL = 'jev-unavailable';

/**
 * ClickHouse `DateTime64(3)` under the server-default `date_time_input_format =
 * basic`, which does NOT accept an ISO-8601 `T` separator or a trailing `Z` — so a
 * raw `toISOString()` is rejected at parse time. Same shape the repo's other
 * DateTime64(3) writer uses (`feed-request-capture.service.ts`); the DateTime
 * writer in `scanner-audit.service.ts` slices to 19 instead, dropping millis.
 *
 * 🔴 This is worth getting right precisely because it CANNOT fail loudly: the
 * client sets `wait_for_async_insert: 0`, so a flush-time parse error is never
 * returned to the caller — `writeShadowEvent`'s catch sees success and the
 * write-failed log never fires. A bad format here leaves the shadow table
 * silently empty, and it is the only data source the M4 gate reads.
 */
function clickhouseDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * The effective suggestion ceiling for one request. Single source for the matcher
 * cap, the cache key and the serve-time truncation, so those three can never
 * disagree about how wide a response is allowed to be.
 */
export function resolveSuggestionLimit(limit: number | undefined): number {
  return clampResourceIntentCap(limit ?? RESOURCE_INTENT_DEFAULT_LIMIT);
}

/**
 * `cap` is part of the key deliberately. It bounds the shortlist, so it bounds
 * the cached `suggestions` — two requests for the same prompt at different caps
 * are DIFFERENT responses, and sharing one entry made a narrow request reuse a
 * wide entry's extra suggestions (and a wide request inherit a narrow entry's
 * truncation) for the full hour TTL. Fragmentation is bounded in practice: a
 * block sends one limit for all its requests, so this is one entry per app, not
 * one per call. `resolveSuggestionLimit` is the second half of the fix — it holds
 * the contract even when an entry written under an older key shape is read back.
 *
 * 🔴 The spec term is `RESOURCE_INTENT_SPEC_HASH`, not `QUESTION_SPEC_VERSION`. The hash is
 * derived from the question spec itself, so ANY edit to it — a reworded prompt, a changed
 * option set, a new `criteria` rubric — invalidates the cache automatically. The
 * hand-maintained integer only does that when someone remembers to bump it, and the schema's
 * own header promises "a question edit invalidates old analytics instead of silently blending
 * with them", which the version term cannot deliver for the CACHE half. Measured in this
 * change: rewording the `specificity` prompt moved the hash and left the version at 1, so a
 * pre-edit entry would have been served for its full hour under the new spec AND stamped into
 * the shadow table with the NEW hash — exactly the blend the pair exists to prevent. The
 * version still rides the shadow event, where it labels the spec generation.
 */
export function resourceIntentCacheKey(input: {
  prompt: string;
  baseModel?: string;
  browsingLevel: number;
  cap: number;
  /** POOL_MERGE only; the HYBRID_10 key is unchanged by this arm's existence. */
  poolMerge?: { snapshot: string };
}) {
  const terms = [
    input.prompt,
    input.baseModel ?? '',
    String(input.browsingLevel),
    String(input.cap),
    RESOURCE_INTENT_SPEC_HASH,
    RESOURCE_INTENT_STAGE3_SPEC_HASH,
  ];
  if (input.poolMerge) {
    terms.push(
      'pool_merge',
      input.poolMerge.snapshot,
      RESOURCE_INTENT_COOC_SPEC_HASH,
      RESOURCE_INTENT_POOL_MERGE_SPEC_HASH
    );
  }
  const hash = createHash('sha256').update(terms.join('|')).digest('hex');
  // `as const` keeps the template-literal type: the redis client is typed over
  // the registered REDIS_KEYS templates and rejects a plain `string`.
  return `${REDIS_KEYS.CACHES.JEV_RESOURCE_INTENT}:${hash}` as const;
}

/**
 * The v1_tags arm's key. `snapshot` is the held tag index's payload sha256 (which covers its
 * vocabulary and tables), or `COOC_FALLBACK_SNAPSHOT_KEY` when none is held; `tagsSpecHash` is
 * `RESOURCE_INTENT_TAGS_SPEC_HASH` ('' when none is held); `RESOURCE_INTENT_V1_GATE_SPEC_HASH` covers
 * the request-time gate and floor, which neither of those does. The stage-1 hash is the last term,
 * which ends no other mode's key, so no other key can equal one of these.
 */
export function v1TagsCacheKey(input: {
  prompt: string;
  baseModel?: string;
  browsingLevel: number;
  cap: number;
  snapshot: string;
  tagsSpecHash: string;
}) {
  const terms = [
    'v1_tags',
    input.prompt,
    input.baseModel ?? '',
    String(input.browsingLevel),
    String(input.cap),
    'addon',
    input.snapshot,
    input.tagsSpecHash,
    RESOURCE_INTENT_V1_GATE_SPEC_HASH,
    RESOURCE_INTENT_SPEC_HASH,
  ];
  const hash = createHash('sha256').update(terms.join('|')).digest('hex');
  return `${REDIS_KEYS.CACHES.JEV_RESOURCE_INTENT}:${hash}` as const;
}

async function hydrateSuggestions(
  ordered: ResourceIntentShortlistEntry[],
  browsingLevel: number
): Promise<ResourceIntentSuggestion[]> {
  if (!ordered.length) return [];
  // 🔴 NO `withPreview` — deliberately, and it is a CLAMP decision, not a cost one.
  // `resourceExceedsCatalogCeiling` reads `level = imageNsfwLevel || (modelNsfw ? R : 0)`,
  // so a PRESENT image level shadows `modelNsfw` entirely. `withPreview` populates that
  // image via `pickPreviewImage`, which only ever returns an image ALREADY visible at
  // `browsingLevel` — so the image level always intersects the ceiling and the re-check
  // becomes a no-op, admitting a `Model.nsfw = true` model with a PG cover to a SFW block.
  // `generation-resources.ts` also omits it, and its own comment confirms the EFFECT —
  // "model.nsfw is the ACTIVE clamp signal in this path" — though not this reasoning:
  // it calls a future cover level desirable. Cited for the effect, not the rationale.
  // The projection emits no image field either way, so requesting one bought nothing.
  // No options at all: `browsingLevel` is read at exactly ONE site inside
  // getResourceData — `pickPreviewImage`, within `if (withPreview)` — so passing it
  // without a preview is inert, and an inert maturity-shaped argument at a call site
  // reads as a clamp that is applied and is not. That is the same shape as the bug
  // above. The clamp that DOES apply is `resourceExceedsCatalogCeiling`, below.
  const resources = await getResourceData(ordered.map((entry) => entry.versionId));
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const suggestions: ResourceIntentSuggestion[] = [];
  for (const entry of ordered) {
    const resource = byId.get(entry.versionId);
    // Re-checked at hydration time, not only in the index filter: the indexed
    // coverage filter is a superset ("SOME version qualified") and can lag.
    if (!resource || !resource.hasAccess) continue;
    if (
      resourceExceedsCatalogCeiling(
        { imageNsfwLevel: resource.image?.nsfwLevel, modelNsfw: resource.model.nsfw },
        browsingLevel
      )
    ) {
      continue;
    }
    suggestions.push(projectSafeGenerationResource(resource));
  }
  return suggestions;
}

type ShadowEvent = {
  time: string;
  promptHash: string;
  promptLength: number;
  baseModel: string;
  browsingLevel: number;
  specHash: string;
  stage3SpecHash: string;
  specVersion: number;
  criteriaVersion: number;
  model: string;
  /** 0/1 rather than a boolean — the column is UInt8. */
  degraded: 0 | 1;
  degradedReason: string;
  latencyMs: number;
  role: string;
  styleFamily: string;
  contentType: string;
  specificity: number;
  needsResource: number;
  injectionPresent: number;
  shortlistCount: number;
  suggestionIds: number[];
  noneProbability: number;
  stage1NoneProbability: number | null;
  stage3NoneProbability: number | null;
} & Partial<PoolMergeShadow> &
  Partial<CheckpointShadow> &
  Partial<V1ServedShadow> &
  Partial<V1ShadowColumns>;

/** Sent on POOL_MERGE, checkpoint and served v1_tags rows; a HYBRID_10 row reads the columns' defaults. */
type PoolMergeShadow = {
  arm: ResourceIntentArm | CheckpointArm;
  coocSnapshotHash: string;
  coocSpecHash: string;
  poolMergeSpecHash: string;
  coocFallback: 0 | 1;
  coocFallbackReason: string;
};

/** Sent on checkpoint rows only (`2026-10-11-resource-intent-shadow-checkpoint.sql`). */
type CheckpointShadow = {
  kind: 'checkpoint';
  checkpointSpecHash: string;
};

/** `2026-10-17-resource-intent-shadow-v1.sql`: what the v1_tags arm read for this prompt. */
type V1TagColumns = {
  tagSnapshotHash: string;
  vocabVersion: string;
  tagsSpecHash: string;
  literalTagCount: number;
  explicitTagsRemoved: number;
  ecosystemSource: '' | 'caller' | 'tags';
  ecosystemTop3: string[];
};

/** Sent on served v1_tags rows only. */
type V1ServedShadow = Partial<V1TagColumns> & { v1Fallback: 0 | 1; v1FallbackReason: string };

/** Sent on rows of other arms whose request ran the v1_tags shadow. */
type V1ShadowColumns = Partial<V1TagColumns> & {
  shadowArm: 'v1_tags';
  shadowDegraded: 0 | 1;
  shadowReason: string;
  shadowSuggestionIds: number[];
  shadowLatencyMs: number;
};

/**
 * Why the v1_tags arm served the POOL_MERGE list: the holder's reason, the scorer's, or
 * `no_candidates` (nothing ranked survived the gates and hydration).
 */
export type V1FallbackReason =
  | TagIndexFallbackReason
  | Exclude<TagScoreResult['status'], 'ok'>
  | 'no_candidates';

/** Resolves after the current turn's microtasks, i.e. after the route has written the response. */
const afterResponse = () => new Promise<void>((resolve) => setImmediate(resolve));

const v1ModelTypes = (kind: TagKind) =>
  kind === 'checkpoint' ? (['Checkpoint'] as const) : RESOURCE_INTENT_COOC_SPEC.addonTypes;

/**
 * The v1 score. A caller's baseModel is the ecosystem and the tags choose none (`scoreTagRequest`);
 * without one, the tags choose only an ecosystem with enough resources under its gate whose base
 * model generates the request's media type. Either way the list's base-model filter is
 * `v1ListBaseModelFilter`'s: the ecosystem's gate, except a caller's checkpoint baseModel exactly.
 */
function scoreV1Tags(index: TagIndex, req: TagRequest): TagScoreResult {
  const gated = gateEligibleEcosystems(index, req.kind, v1ModelTypes(req.kind));
  const modality = modalityEligibleEcosystems(index, V1_TAGS_REQUEST_MEDIA_TYPE);
  const rankable = new Set([...gated].filter((id) => modality.has(id)));
  return scoreTagRequest(index, req, TAG_SCORE_PARAMS, rankable);
}

/** The scored candidates through the gates and hydration; `fallbackReason` null when v1 has a list. */
async function listV1Tags(
  score: TagScoreResult,
  req: {
    kind: TagKind;
    baseModel: string | undefined;
    browsingLevel: number;
    coverage: ResourceIntentCoverage;
    cap: number;
  }
): Promise<{
  entries: ResourceIntentShortlistEntry[];
  suggestions: ResourceIntentSuggestion[];
  fallbackReason: V1FallbackReason | null;
}> {
  if (score.status !== 'ok' || !score.ecosystem)
    return {
      entries: [],
      suggestions: [],
      fallbackReason: score.status === 'ok' ? 'unknown_ecosystem' : score.status,
    };
  const modelTypes = v1ModelTypes(req.kind);
  const entries = await findRankedCandidates({
    maxModels: V1_TAGS_LIST_MODELS,
    modelIds: score.candidates.map((c) => c.modelId),
    modelTypes,
    baseModel: v1ListBaseModelFilter(req.kind, !!req.baseModel, score.ecosystem, modelTypes),
    browsingLevel: req.browsingLevel,
    coverage: req.coverage,
    cap: req.cap,
  });
  const suggestions = await hydrateSuggestions(entries, req.browsingLevel);
  return { entries, suggestions, fallbackReason: suggestions.length ? null : 'no_candidates' };
}

function v1TagColumns(
  snapshot: ServedTagIndex,
  score: TagScoreResult | null,
  baseModel: string | undefined
): V1TagColumns {
  return {
    tagSnapshotHash: snapshot.payloadSha256,
    vocabVersion: snapshot.vocabVersion,
    tagsSpecHash: snapshot.specHash,
    literalTagCount: score?.foundTagIds.length ?? 0,
    explicitTagsRemoved: score ? score.foundTagIds.length - score.weights.size : 0,
    ecosystemSource: !score ? '' : baseModel ? 'caller' : score.ecosystem ? 'tags' : '',
    ecosystemTop3: score?.ecosystems ?? [],
  };
}

/**
 * Per pod. The shadow's search shares the foreground's `withMeiliResourceSelect` limiter, which
 * queues; past this cap a shadow is skipped instead, so shadows add at most 4 to its load.
 */
const V1_SHADOW_MAX_IN_FLIGHT = 4;
let v1ShadowsInFlight = 0;

/**
 * The v1_tags list this request would have been served, for the shadow columns of its row. Makes no
 * vendor call. Never throws: a failure is reported in the columns.
 */
async function v1TagsShadow(
  input: ResourceIntentInput,
  kind: TagKind,
  ctx: ResourceIntentContext,
  cap: number
): Promise<V1ShadowColumns> {
  const startedAt = Date.now();
  let tags: Partial<V1TagColumns> = {};
  const columns = (outcome: { shadowReason: string; shadowDegraded?: 0 | 1; ids?: number[] }) => ({
    ...tags,
    shadowArm: 'v1_tags' as const,
    shadowDegraded: outcome.shadowDegraded ?? 0,
    shadowReason: outcome.shadowReason,
    shadowSuggestionIds: outcome.ids ?? [],
    shadowLatencyMs: Date.now() - startedAt,
  });
  if (v1ShadowsInFlight >= V1_SHADOW_MAX_IN_FLIGHT) return columns({ shadowReason: 'skipped' });
  v1ShadowsInFlight++;
  try {
    const serving = await tagIndexSnapshotHolder().resolve();
    if (!serving.snapshot) return columns({ shadowReason: serving.fallbackReason });
    const req = { kind, browsingLevel: ctx.browsingLevel, baseModel: input.baseModel };
    const score = scoreV1Tags(serving.snapshot.index, { ...req, prompt: input.prompt });
    tags = v1TagColumns(serving.snapshot, score, input.baseModel);
    const coverage = ctx.coverage ?? (await coverageAudience(undefined));
    const listed = await listV1Tags(score, { ...req, coverage, cap });
    return columns({
      shadowReason: listed.fallbackReason ?? '',
      ids: listed.suggestions.map((s) => s.versionId),
    });
  } catch {
    return columns({ shadowReason: 'error', shadowDegraded: 1 });
  } finally {
    v1ShadowsInFlight--;
  }
}

export const JUDGE_SAMPLE_TABLE = 'p2m_restricted.routeJudgeSample';

/**
 * One judge-capture row (`2026-10-17-resource-intent-route-judge-sample.sql`). Carries no caller
 * field, but joins its request's shadow row by `promptHash`; the table's row policies are the
 * read control. Never logged anywhere else: with no ClickHouse client the row is dropped.
 */
async function writeJudgeSample(row: {
  time: string;
  promptHash: string;
  prompt: string;
  browsingLevel: number;
  baseModel: string;
}): Promise<void> {
  if (!clickhouse) return;
  try {
    await clickhouse.insert({ table: JUDGE_SAMPLE_TABLE, values: [row], format: 'JSONEachRow' });
  } catch {
    // Not logged: the error text could carry the prompt.
  }
}

async function writeShadowEvent(event: ShadowEvent): Promise<void> {
  try {
    if (clickhouse) {
      await clickhouse.insert({
        table: 'resourceIntentShadow',
        values: [event],
        format: 'JSONEachRow',
      });
    } else {
      // No ClickHouse wiring (dev/build) — the structured log is the fallback.
      await logToAxiom({ type: 'resource-intent-shadow', ...event }, 'temp-search');
    }
  } catch (error) {
    // Never fail the request on telemetry.
    await logToAxiom(
      {
        type: 'resource-intent-shadow-write-failed',
        error: error instanceof Error ? error.message : String(error),
      },
      'temp-search'
    ).catch(() => undefined);
  }
}

function degradedResponse(
  insightFallback: boolean,
  armFields: Pick<
    ResourceIntentResponse,
    'coocFallback' | 'kind' | 'checkpointArm' | 'arm' | 'v1Fallback'
  >,
  model: string = DEGRADED_MODEL
): ResourceIntentResponse {
  return {
    degraded: true,
    insightFallback,
    ...armFields,
    intent: null,
    criteria: null,
    suggestions: [],
    noneProbability: null,
    model,
    criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
  };
}

function logDegraded(degradedReason: string, error: unknown, model: string) {
  logToAxiom(
    {
      type: 'resource-intent-degraded',
      degradedReason,
      error: error instanceof Error ? error.message : String(error),
      model,
    },
    'temp-search'
  ).catch(() => undefined);
}

export type ResourceIntentContext = {
  browsingLevel: number;
  /** Overrides the anon coverageAudience lookup (tests; special tRPC callers). */
  coverage?: ResourceIntentCoverage;
  /** Clock for the shadow-event timestamp and the study pin check; injectable for tests. */
  now?: () => Date;
  /** Serve the co-occurrence POOL_MERGE list (flag `resourceIntentPoolMerge`). Add-on mode only. */
  poolMerge?: boolean;
  /**
   * STUDY MODE: serve POOL_MERGE (add-on mode) or ATTACH_BM (checkpoint mode) from this pinned
   * study snapshot (its content hash). Fails closed — `degraded: true` — if the snapshot cannot
   * be served, and never falls back. Ignored on the `base_bm` arm, which reads no snapshot.
   */
  coocSnapshotId?: string;
  /** Checkpoint mode's arm; `attach_bm` (the served arm) when absent. The study sets `base_bm`. */
  checkpointArm?: CheckpointArm;
  /** Serve the v1_tags list (flag `resourceIntentV1`), over `poolMerge`. Add-on mode only; not in study mode. */
  v1?: boolean;
  /** Compute the v1_tags list after responding and record it on the row (`resourceIntentV1Shadow`). */
  v1Shadow?: boolean;
  /** Record the prompt for the judged comparison (`resourceIntentJudgeCapture`). Add-on mode only. */
  judgeCapture?: boolean;
};

export async function getResourceIntent(
  input: ResourceIntentInput,
  ctx: ResourceIntentContext
): Promise<ResourceIntentResponse> {
  if (input.kind === 'checkpoint') return getCheckpointIntent(input, ctx);
  const startedAt = Date.now();
  // Resolved BEFORE the cache read: `cap` is part of the cache key, so it cannot
  // be computed on the miss path only.
  const cap = resolveSuggestionLimit(input.limit);
  const study = ctx.coocSnapshotId !== undefined;
  const arm: ResourceIntentArm =
    ctx.v1 && !study ? 'v1_tags' : ctx.poolMerge || study ? 'pool_merge' : 'hybrid_10';

  // The snapshot is part of the POOL_MERGE cache key, so it is resolved before the cache read.
  let cooc: ServedCooc | null = null;
  let coocServing: CoocServing | null = null;
  let studyFailure: { error: unknown } | null = null;
  // Likewise the tag index for v1_tags. That arm reads the co-occurrence snapshot only on a fallback.
  let tagServing: TagIndexServing | null = null;
  if (study) {
    try {
      cooc = await coocStudySnapshots().get(ctx.coocSnapshotId!, (ctx.now ?? (() => new Date()))());
    } catch (error) {
      studyFailure = { error };
    }
  } else if (arm === 'pool_merge') {
    coocServing = await coocSnapshotHolder().resolve();
    cooc = coocServing.snapshot;
  } else if (arm === 'v1_tags') {
    tagServing = await tagIndexSnapshotHolder().resolve();
  }
  let coocFallback = arm === 'pool_merge' && !study && !cooc;
  let tagScore: TagScoreResult | null = null;
  let v1FallbackReason: V1FallbackReason | 'cached_fallback' | null =
    tagServing && !tagServing.snapshot ? tagServing.fallbackReason : null;

  const cacheKey = tagServing
    ? v1TagsCacheKey({
        prompt: input.prompt,
        baseModel: input.baseModel,
        browsingLevel: ctx.browsingLevel,
        cap,
        snapshot: tagServing.snapshot?.payloadSha256 ?? COOC_FALLBACK_SNAPSHOT_KEY,
        // The snapshot's own hash, not an import of spec.ts, which fingerprints fixtures on load.
        tagsSpecHash: tagServing.snapshot?.specHash ?? '',
      })
    : resourceIntentCacheKey({
        prompt: input.prompt,
        baseModel: input.baseModel,
        browsingLevel: ctx.browsingLevel,
        cap,
        ...(arm === 'pool_merge' && {
          poolMerge: {
            snapshot: study ? ctx.coocSnapshotId! : cooc?.contentHash ?? COOC_FALLBACK_SNAPSHOT_KEY,
          },
        }),
      });
  // Spread only on these arms, so a HYBRID_10 response is unchanged.
  let armFields: Pick<
    ResourceIntentResponse,
    'coocFallback' | 'arm' | 'v1Fallback' | 'ecosystems'
  > =
    arm === 'pool_merge'
      ? { coocFallback }
      : arm === 'v1_tags'
      ? { arm, v1Fallback: !tagServing?.snapshot }
      : {};

  let stage1Model = DEGRADED_MODEL;
  let shortlistCount = 0;
  let stage3NoneProbability: number | null = null;
  // Tracked outside the try so the degraded response below carries it too: if the
  // label read failed and THEN stage 3 failed, the fact that the ordering never ran
  // still describes this computation. (A degrade already takes a short TTL, so this
  // changes no TTL — what it keeps honest is the value a cache replay reports.)
  let insightFallback = false;
  let degradedReason: string | null = null;
  let response: ResourceIntentResponse | undefined;
  let cachedHit = false;

  if (studyFailure) {
    // Fails closed without the cache: an expired pin must not keep serving a cached list.
    degradedReason = 'cooc_study_snapshot';
    response = degradedResponse(false, armFields);
    logDegraded(degradedReason, studyFailure.error, stage1Model);
  }

  // The flag gate happens BEFORE this function (and before this cache read) in
  // every caller — by the time we are here the feature is enabled.
  if (!response) {
    try {
      const cached = await redis.packed.get<unknown>(cacheKey);
      if (cached != null) {
        const parsed = resourceIntentResponseSchema.safeParse(cached);
        if (parsed.success) {
          response = parsed.data;
          cachedHit = true;
        }
      }
    } catch {
      // A cache read failure is a miss, never an error.
    }
  }

  if (!response) {
    const baseModel = input.baseModel ?? null;
    // Resolved on a cache miss only (see the route's comment).
    const coverage = ctx.coverage ?? (await coverageAudience(undefined));
    try {
      const stage1 = await askJev(buildResourceIntentStage1Request(input.prompt, baseModel), {
        timeoutMs: JEV_TIMEOUT_MS,
      });
      stage1Model = stage1.model;

      const intent = parseResourceIntentStage1Answers(stage1.answers);
      if (!intent) {
        degradedReason = 'jev_stage1_shape';
        throw new Error('stage-1 answers did not match the question spec');
      }
      const criteria = compileCriteria(intent, baseModel);

      let suggestions: ResourceIntentSuggestion[] = [];
      const stage1NoneProbability = intent.role.distribution['none'] ?? null;

      const poolMerge = async () => {
        if (criteria.role === 'none') return;
        const coocCandidates = cooc
          ? rankCooc(
              cooc.scores,
              coocQueryTokens(input.prompt),
              criteria.modelTypes,
              RESOURCE_INTENT_COOC_SPEC.topK
            ).map((c) => c.modelId)
          : [];
        const merged = await findPoolMergeCandidates(criteria, {
          browsingLevel: ctx.browsingLevel,
          coverage,
          cap,
          coocCandidates,
        });
        shortlistCount = merged.entries.length;
        suggestions = await hydrateSuggestions(merged.entries, ctx.browsingLevel);
      };

      if (arm === 'v1_tags') {
        // Role-free: stage 1 runs only for `intent`/`criteria` (and the fallback's role filter).
        if (tagServing?.snapshot) {
          tagScore = scoreV1Tags(tagServing.snapshot.index, {
            prompt: input.prompt,
            baseModel: input.baseModel,
            kind: 'addon',
            browsingLevel: ctx.browsingLevel,
          });
          const listed = await listV1Tags(tagScore, {
            kind: 'addon',
            baseModel: input.baseModel,
            browsingLevel: ctx.browsingLevel,
            coverage,
            cap,
          });
          shortlistCount = listed.entries.length;
          suggestions = listed.suggestions;
          v1FallbackReason = listed.fallbackReason;
        }
        if (v1FallbackReason) {
          coocServing = await coocSnapshotHolder().resolve();
          cooc = coocServing.snapshot;
          coocFallback = !cooc;
          armFields = { arm, v1Fallback: true, coocFallback };
          shortlistCount = 0;
          suggestions = [];
          await poolMerge();
        } else if (!input.baseModel && tagScore) {
          armFields = { ...armFields, ecosystems: tagScore.ecosystems };
        }
      } else if (criteria.role !== 'none' && arm === 'pool_merge') {
        await poolMerge();
      } else if (criteria.role !== 'none') {
        const matched = await findResourceIntentCandidates(criteria, {
          browsingLevel: ctx.browsingLevel,
          coverage,
          cap,
        });
        const shortlist = matched.entries;
        insightFallback = matched.insightFallback;
        shortlistCount = shortlist.length;
        let head: ResourceIntentShortlistEntry[] = [];
        if (shortlist.length > 0) {
          const orders = stage3Orders(shortlist, matched.pool);
          const state = buildStage3State(input.prompt, criteria);
          const stage3 = await Promise.all(
            orders.map((order) =>
              askJev(
                { state, questions: [buildStage3Question(order.map((i) => shortlist[i]))] },
                { timeoutMs: JEV_TIMEOUT_MS }
              )
            )
          );
          const distributions = stage3.map(({ answers: [answer] }) => {
            if (answer?.type !== 'choice') {
              degradedReason = 'jev_stage3_shape';
              throw new Error('stage-3 answer did not match the question spec');
            }
            return answer.distribution;
          });
          const combined = combineStage3Answers(shortlist.length, orders, distributions);
          stage3NoneProbability = combined.noneProbability;
          head = combined.order.map((i) => shortlist[i]);
        }
        const ranked = mergeHybrid(
          head,
          matched.basePool,
          Math.min(RESOURCE_INTENT_HYBRID_HEAD_MODELS, cap),
          cap
        );
        suggestions = await hydrateSuggestions(ranked, ctx.browsingLevel);
      }

      response = {
        degraded: false,
        insightFallback,
        ...armFields,
        intent,
        criteria,
        suggestions,
        noneProbability: stage3NoneProbability ?? stage1NoneProbability,
        model: stage1.model,
        criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      };
    } catch (error) {
      degradedReason =
        degradedReason ?? (error instanceof JevError ? `jev_${error.kind}` : 'jev_error');
      response = degradedResponse(insightFallback, armFields);
      logDegraded(degradedReason, error, stage1Model);
    }
    if (coocFallback) {
      logToAxiom(
        { type: 'resource-intent-cooc-fallback', reason: coocServing?.fallbackReason ?? '' },
        'temp-search'
      ).catch(() => undefined);
    }
  }

  // The caller's ceiling is enforced on the way OUT, independently of how the
  // response was produced, and BEFORE the cache write / shortlist count / shadow
  // event so all three describe the response actually returned. `cap` is in the
  // cache key and the matcher already capped, so this is a no-op for a fresh
  // entry; it holds the contract for one written under an older key shape, which
  // would otherwise over-serve until its TTL expired.
  if (response.suggestions.length > cap) {
    response = { ...response, suggestions: response.suggestions.slice(0, cap) };
  }

  if (!cachedHit && !studyFailure) {
    try {
      await redis.packed.set(cacheKey, response, {
        EX: responseCacheTtl(response),
      });
    } catch {
      // A cache write failure never fails the request.
    }
  } else if (cachedHit) {
    // The matcher never ran, so the shortlist size is unknown; the hydrated
    // post-gate count is recorded instead of a misleading zero.
    shortlistCount = response.suggestions.length;
    if (response.degraded) {
      // A degrade served from cache (60s TTL) never entered the catch, so it has
      // no reason of its own and emits no `resource-intent-degraded` log. Without
      // this it lands in the shadow table as `degraded=1` with an EMPTY reason —
      // and the migration's own fallback-rate query groups BY reason, so those
      // rows would pool in a blank bucket that reads like a writer bug. Naming
      // the replay keeps that query honest and keeps cached degrades countable
      // separately from the vendor failures that caused them.
      degradedReason = 'cached_degrade';
    }
    // A held snapshot's fallback reason was not cached; without one, the holder's still applies.
    if (response.v1Fallback && tagServing?.snapshot) v1FallbackReason = 'cached_fallback';
  }

  // Taken now: the row describes the response, not the shadow work that runs after it.
  const time = clickhouseDateTime64((ctx.now ?? (() => new Date()))());
  const latencyMs = Date.now() - startedAt;
  const promptHash = createHash('sha256').update(input.prompt).digest('hex');
  const shadowV1 = !!ctx.v1Shadow && arm !== 'v1_tags';
  void (async () => {
    if (shadowV1 || ctx.judgeCapture) await afterResponse();
    if (ctx.judgeCapture)
      void writeJudgeSample({
        time,
        promptHash,
        prompt: input.prompt,
        browsingLevel: ctx.browsingLevel,
        baseModel: input.baseModel ?? '',
      });
    const shadow = shadowV1 ? await v1TagsShadow(input, 'addon', ctx, cap) : null;
    const answer = response?.intent;
    // Degraded rows carry zero/empty summary columns; `degraded` discriminates.
    await writeShadowEvent({
      time,
      promptHash,
      promptLength: input.prompt.length,
      baseModel: input.baseModel ?? '',
      browsingLevel: ctx.browsingLevel,
      specHash: RESOURCE_INTENT_SPEC_HASH,
      stage3SpecHash: RESOURCE_INTENT_STAGE3_SPEC_HASH,
      specVersion: QUESTION_SPEC_VERSION,
      criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      model: response?.model ?? DEGRADED_MODEL,
      degraded: response?.degraded ? 1 : 0,
      degradedReason: degradedReason ?? '',
      latencyMs,
      role: answer?.role.value ?? '',
      styleFamily: answer?.styleFamily.value ?? '',
      contentType: answer?.contentType.value ?? '',
      specificity: answer?.specificity ?? 0,
      needsResource: answer?.needsResource ?? 0,
      injectionPresent: answer?.injectionPresent ?? 0,
      shortlistCount,
      suggestionIds: (response?.suggestions ?? []).map((suggestion) => suggestion.versionId),
      noneProbability: response?.noneProbability ?? 0,
      stage1NoneProbability: answer?.role.distribution['none'] ?? null,
      // Not cached, so a cache hit records NULL here: this column describes stage 3 as
      // run by THIS request.
      stage3NoneProbability: response?.degraded ? null : stage3NoneProbability,
      ...(arm === 'pool_merge' && {
        arm,
        coocSnapshotHash: study ? ctx.coocSnapshotId! : cooc?.contentHash ?? '',
        coocSpecHash: RESOURCE_INTENT_COOC_SPEC_HASH,
        poolMergeSpecHash: RESOURCE_INTENT_POOL_MERGE_SPEC_HASH,
        coocFallback: coocFallback ? 1 : 0,
        coocFallbackReason: coocServing?.fallbackReason ?? '',
      }),
      ...(arm === 'v1_tags' && {
        arm,
        // The POOL_MERGE columns describe the fallback list, and are blank on v1's own.
        coocSnapshotHash: cooc?.contentHash ?? '',
        coocSpecHash: response.v1Fallback ? RESOURCE_INTENT_COOC_SPEC_HASH : '',
        poolMergeSpecHash: response.v1Fallback ? RESOURCE_INTENT_POOL_MERGE_SPEC_HASH : '',
        coocFallback: response.coocFallback ? 1 : 0,
        coocFallbackReason: coocServing?.fallbackReason ?? '',
        v1Fallback: response.v1Fallback ? 1 : 0,
        v1FallbackReason: v1FallbackReason ?? '',
        ...(tagServing?.snapshot && v1TagColumns(tagServing.snapshot, tagScore, input.baseModel)),
      }),
      ...shadow,
    });
  })();

  return response;
}

/** The `model` of an undegraded checkpoint-mode response: no vendor model produced it. */
export const CHECKPOINT_MODEL = 'none';
/**
 * The `model` of a degraded checkpoint-mode response. Not the add-on path's `'jev-unavailable'`:
 * no vendor call is made in this mode, so its degrades must not read as vendor failures.
 */
export const CHECKPOINT_DEGRADED_MODEL = 'checkpoint-unavailable';

/**
 * Checkpoint mode's cache key. The prompt is NOT a term: neither arm reads it, so keying on it
 * would only split identical lists. Coverage IS a term (the add-on key leaves it out): it is
 * resolved before the cache read here, and with no prompt in the key one entry serves every
 * request for an ecosystem, so a coverage change must not wait out the TTL. The width is the
 * served one, `min(cap, 50)`. The last term is always `RESOURCE_INTENT_CHECKPOINT_SPEC_HASH`, so no
 * add-on key (whose last term is a stage spec hash) can equal one of these.
 */
export function checkpointIntentCacheKey(input: {
  arm: CheckpointArm;
  baseModel: string;
  browsingLevel: number;
  width: number;
  coverage: ResourceIntentCoverage;
  /** `attach_bm` only: the snapshot's content hash, or `COOC_FALLBACK_SNAPSHOT_KEY`. */
  snapshot?: string;
}) {
  const terms = [
    'checkpoint',
    input.arm,
    input.baseModel,
    String(input.browsingLevel),
    String(input.width),
    `next:${input.coverage.next}`,
    `member:${input.coverage.member}`,
  ];
  if (input.arm === 'attach_bm') {
    terms.push(
      input.snapshot ?? COOC_FALLBACK_SNAPSHOT_KEY,
      RESOURCE_INTENT_COOC_SPEC_HASH,
      CHECKPOINT_ATTACH_BUILD_HASH
    );
  }
  terms.push(RESOURCE_INTENT_CHECKPOINT_SPEC_HASH);
  const hash = createHash('sha256').update(terms.join('|')).digest('hex');
  return `${REDIS_KEYS.CACHES.JEV_RESOURCE_INTENT}:${hash}` as const;
}

/**
 * `kind: 'checkpoint'`: no stage 1, no stage 3, no vendor call. The list is the arm's
 * (`findCheckpointCandidates`), hydrated and re-gated like every other list.
 *
 * - `attach_bm` with no servable snapshot section serves BASE_BM's list instead, flagged
 *   `coocFallback` with the holder's reason, for 60 s — the POOL_MERGE fallback contract. A
 *   snapshot with no checkpoint section (built before it existed, or with the section-writer flag
 *   off) or one under another section build hash reports `spec_mismatch`.
 * - Study mode (`ctx.coocSnapshotId`, `attach_bm`) fails closed, uncached, like POOL_MERGE's.
 * - A search or hydration failure degrades (`degraded: true`, empty suggestions, `intent` and
 *   `criteria` `null`, as every degraded response). This mode's degrades, the study fail-closed
 *   included, report `model: 'checkpoint-unavailable'` (`CHECKPOINT_DEGRADED_MODEL`), never the
 *   add-on path's vendor label.
 */
async function getCheckpointIntent(
  input: ResourceIntentInput,
  ctx: ResourceIntentContext
): Promise<ResourceIntentResponse> {
  const startedAt = Date.now();
  const baseModel = input.baseModel;
  // The input schema requires it; this guards a caller that skipped the schema.
  if (!baseModel) throw new Error("baseModel is required when kind is 'checkpoint'");
  const cap = resolveSuggestionLimit(input.limit);
  const width = Math.min(cap, CHECKPOINT_LIST_MODELS);
  const arm: CheckpointArm = ctx.checkpointArm ?? 'attach_bm';
  const study = arm === 'attach_bm' && ctx.coocSnapshotId !== undefined;
  const now = ctx.now ?? (() => new Date());

  let served: ServedCooc | null = null;
  let fallbackReason: CoocFallbackReason | null = null;
  let studyFailure: { error: unknown } | null = null;
  if (study) {
    try {
      served = await coocStudySnapshots().get(ctx.coocSnapshotId!, now());
      if (!served.checkpoints)
        throw new Error(`study snapshot ${ctx.coocSnapshotId} has no servable checkpoint section`);
    } catch (error) {
      studyFailure = { error };
    }
  } else if (arm === 'attach_bm') {
    const serving: CoocServing = await coocSnapshotHolder().resolve();
    served = serving.snapshot;
    if (!served) fallbackReason = serving.fallbackReason;
    else if (!served.checkpoints) fallbackReason = 'spec_mismatch';
  }
  const attach = served?.checkpoints ?? null;
  const coocFallback = arm === 'attach_bm' && !study && !attach;
  const snapshotHash = study ? ctx.coocSnapshotId! : attach ? served!.contentHash : '';
  const armFields = {
    kind: 'checkpoint' as const,
    checkpointArm: arm,
    ...(arm === 'attach_bm' && { coocFallback }),
  };

  let degradedReason: string | null = null;
  let response: ResourceIntentResponse | undefined;
  let cachedHit = false;
  let shortlistCount = 0;
  let cacheKey: ReturnType<typeof checkpointIntentCacheKey> | null = null;

  if (studyFailure) {
    // Fails closed without the cache, as POOL_MERGE's study mode does.
    degradedReason = 'cooc_study_snapshot';
    response = degradedResponse(false, armFields, CHECKPOINT_DEGRADED_MODEL);
    logDegraded(degradedReason, studyFailure.error, CHECKPOINT_DEGRADED_MODEL);
  } else {
    try {
      // Before the cache read: it is part of this mode's key.
      const coverage = ctx.coverage ?? (await coverageAudience(undefined));
      cacheKey = checkpointIntentCacheKey({
        arm,
        baseModel,
        browsingLevel: ctx.browsingLevel,
        width,
        coverage,
        ...(arm === 'attach_bm' && {
          snapshot: attach ? snapshotHash : COOC_FALLBACK_SNAPSHOT_KEY,
        }),
      });
      try {
        const cached = await redis.packed.get<unknown>(cacheKey);
        if (cached != null) {
          const parsed = resourceIntentResponseSchema.safeParse(cached);
          if (parsed.success) {
            response = parsed.data;
            cachedHit = true;
          }
        }
      } catch {
        // A cache read failure is a miss, never an error.
      }
      if (!response) {
        const entries = await findCheckpointCandidates({
          arm,
          baseModel,
          attachCandidates: attach ? attach.candidates.get(baseModel) ?? [] : null,
          browsingLevel: ctx.browsingLevel,
          coverage,
          cap,
        });
        shortlistCount = entries.length;
        response = {
          degraded: false,
          insightFallback: false,
          ...armFields,
          intent: null,
          criteria: null,
          suggestions: await hydrateSuggestions(entries, ctx.browsingLevel),
          noneProbability: null,
          model: CHECKPOINT_MODEL,
          criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
        };
      }
    } catch (error) {
      degradedReason = 'checkpoint_error';
      response = degradedResponse(false, armFields, CHECKPOINT_DEGRADED_MODEL);
      logDegraded(degradedReason, error, CHECKPOINT_DEGRADED_MODEL);
    }
    if (coocFallback && !cachedHit) {
      logToAxiom(
        { type: 'resource-intent-cooc-fallback', reason: fallbackReason ?? '', kind: 'checkpoint' },
        'temp-search'
      ).catch(() => undefined);
    }
  }

  // The served list is already at most `width` wide; this holds the contract for a cached entry.
  if (response.suggestions.length > cap) {
    response = { ...response, suggestions: response.suggestions.slice(0, cap) };
  }

  if (cacheKey && !cachedHit) {
    try {
      await redis.packed.set(cacheKey, response, { EX: responseCacheTtl(response) });
    } catch {
      // A cache write failure never fails the request.
    }
  } else if (cachedHit) {
    shortlistCount = response.suggestions.length;
    if (response.degraded) degradedReason = 'cached_degrade';
  }

  const final = response;
  const time = clickhouseDateTime64(now());
  const latencyMs = Date.now() - startedAt;
  // Checkpoints stay on this mode's arms; v1_tags is only shadowed here.
  const shadowV1 = !!ctx.v1Shadow;
  void (async () => {
    if (shadowV1) await afterResponse();
    const shadow = shadowV1 ? await v1TagsShadow(input, 'checkpoint', ctx, cap) : null;
    await writeShadowEvent({
      time,
      promptHash: createHash('sha256').update(input.prompt).digest('hex'),
      promptLength: input.prompt.length,
      baseModel,
      browsingLevel: ctx.browsingLevel,
      // No question spec ran: blank, and specVersion 0 keeps these rows out of the spec-pinned
      // role-mix query.
      specHash: '',
      stage3SpecHash: '',
      specVersion: 0,
      criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      model: final.model,
      degraded: final.degraded ? 1 : 0,
      degradedReason: degradedReason ?? '',
      latencyMs,
      role: '',
      styleFamily: '',
      contentType: '',
      specificity: 0,
      needsResource: 0,
      injectionPresent: 0,
      shortlistCount,
      suggestionIds: final.suggestions.map((suggestion) => suggestion.versionId),
      noneProbability: 0,
      stage1NoneProbability: null,
      stage3NoneProbability: null,
      arm,
      coocSnapshotHash: snapshotHash,
      coocSpecHash: arm === 'attach_bm' ? RESOURCE_INTENT_COOC_SPEC_HASH : '',
      poolMergeSpecHash: '',
      coocFallback: coocFallback ? 1 : 0,
      coocFallbackReason: fallbackReason ?? '',
      kind: 'checkpoint',
      checkpointSpecHash: RESOURCE_INTENT_CHECKPOINT_SPEC_HASH,
      ...shadow,
    });
  })();

  return final;
}
