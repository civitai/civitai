import { createHash } from 'crypto';

import { clickhouse } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import {
  RESOURCE_INTENT_CRITERIA_VERSION,
  RESOURCE_INTENT_DEFAULT_LIMIT,
  RESOURCE_INTENT_MAX_SHORTLIST,
  RESOURCE_INTENT_QUESTIONS,
  RESOURCE_INTENT_SPEC_HASH,
  QUESTION_SPEC_VERSION,
  STAGE3_MAX_RANKED,
  resourceIntentAnswerSchema,
  resourceIntentResponseSchema,
  ROLE_MODEL_TYPES,
  type ResourceIntentAnswer,
  type ResourceIntentCriteria,
  type ResourceIntentInput,
  type ResourceIntentResponse,
  type ResourceIntentSuggestion,
} from '~/server/schema/resource-intent.schema';
import { projectSafeGenerationResource } from '~/server/schema/blocks/generation-resource-projection';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { askJev, JEV_TIMEOUT_MS, JevError, type JevChoiceQuestion } from '~/server/services/ai/jev';
import { getResourceData } from '~/server/services/generation/generation.service';
import {
  findResourceIntentCandidates,
  type ResourceIntentCoverage,
  type ResourceIntentShortlistEntry,
} from '~/server/services/resource-intent-matcher.service';
import { coverageAudience } from '~/server/services/generation/coverage-source';
import { resourceExceedsCatalogCeiling } from '~/server/utils/block-catalog-maturity';

/**
 * Resource-intent primitive — cache → Jev stage 1 (intent/criteria) →
 * deterministic matcher → Jev stage 3 (Choice over the shortlist) → suggestions.
 *
 * Fail-closed: ANY error in ANY stage returns `degraded: true` with empty
 * suggestions and no thrown error — callers treat it as "no suggestion". Jev
 * output can only reorder/drop within the gate-passing shortlist; every gate
 * (availability, maturity, coverage, baseModel, celebrity) is applied in
 * deterministic code BEFORE Jev ranks, and the stage-3 option list contains
 * exactly the shortlisted keys, so an unknown version can never be added.
 *
 * `none` is a first-class answer: when stage 1's role argmax is `none` (or
 * stage 3 picks `none`), the response carries empty suggestions without being
 * degraded — the model judged the prompt needs no resource.
 *
 * Exported as a plain async function so internal (tRPC) consumers reuse this
 * exact flow; the block REST endpoint adds auth/maturity/rate-limit around it.
 */

const CACHE_TTL_SECONDS = 60 * 60;
// Jev failures are often transient (vendor 5xx, timeout); caching a degraded
// response for the full hour would pin an empty result to the prompt, so
// degrades cache briefly — a retry window without hammering the vendor.
const DEGRADED_CACHE_TTL_SECONDS = 60;

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
  return Math.min(limit ?? RESOURCE_INTENT_DEFAULT_LIMIT, RESOURCE_INTENT_MAX_SHORTLIST);
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
 */
export function resourceIntentCacheKey(input: {
  prompt: string;
  baseModel?: string;
  browsingLevel: number;
  cap: number;
}) {
  const hash = createHash('sha256')
    .update(
      [
        input.prompt,
        input.baseModel ?? '',
        String(input.browsingLevel),
        String(input.cap),
        String(QUESTION_SPEC_VERSION),
      ].join('|')
    )
    .digest('hex');
  // `as const` keeps the template-literal type: the redis client is typed over
  // the registered REDIS_KEYS templates and rejects a plain `string`.
  return `${REDIS_KEYS.CACHES.JEV_RESOURCE_INTENT}:${hash}` as const;
}

function compileCriteria(
  answer: ResourceIntentAnswer,
  baseModel: string | null
): ResourceIntentCriteria {
  const role = answer.role.value;
  return {
    criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
    specHash: RESOURCE_INTENT_SPEC_HASH,
    role,
    modelTypes: ROLE_MODEL_TYPES[role] ? [...ROLE_MODEL_TYPES[role]!] : null,
    baseModel,
  };
}

export function buildStage3Question(shortlist: ResourceIntentShortlistEntry[]): JevChoiceQuestion {
  // Jev Choice caps at 255 options and `none` always rides along, so the ranked
  // list leaves it room (the default shortlist of 50 never hits this).
  const ranked = shortlist.slice(0, STAGE3_MAX_RANKED);
  return {
    id: 'resourceVersion',
    type: 'choice',
    prompt: [
      'Given the prompt, which of these community resources (if any) fits best? Reply with the option key of the best match, or "none" if no listed resource fits.',
      ...ranked.map(
        (entry, i) =>
          `${i}: ${entry.modelName} — ${entry.versionName} (${entry.modelType}, ${entry.baseModel})`
      ),
    ].join('\n'),
    options: [...ranked.map((_, i) => String(i)), 'none'],
  };
}

function reorderShortlistByDistribution(
  shortlist: ResourceIntentShortlistEntry[],
  distribution: Record<string, number>
): ResourceIntentShortlistEntry[] {
  return shortlist
    .map((entry, index) => ({ entry, index, probability: distribution[String(index)] ?? 0 }))
    .sort((a, b) => {
      if (a.probability !== b.probability) return b.probability - a.probability;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
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
  // `generation-resources.ts` omits it for exactly this reason (see its own comment), and
  // the projection emits no image field, so requesting one bought nothing but that hole.
  const resources = await getResourceData(
    ordered.map((entry) => entry.versionId),
    { browsingLevel }
  );
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
};

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

export async function getResourceIntent(
  input: ResourceIntentInput,
  ctx: {
    browsingLevel: number;
    /** Overrides the anon coverageAudience lookup (tests; special tRPC callers). */
    coverage?: ResourceIntentCoverage;
    /** Shadow-event timestamp; injectable for tests. */
    now?: () => Date;
  }
): Promise<ResourceIntentResponse> {
  const startedAt = Date.now();
  // Resolved BEFORE the cache read: `cap` is part of the cache key, so it cannot
  // be computed on the miss path only.
  const cap = resolveSuggestionLimit(input.limit);
  const cacheInput = {
    prompt: input.prompt,
    baseModel: input.baseModel,
    browsingLevel: ctx.browsingLevel,
    cap,
  };

  let stage1Model = DEGRADED_MODEL;
  let shortlistCount = 0;
  let degradedReason: string | null = null;
  let response: ResourceIntentResponse | undefined;
  let cachedHit = false;

  // The flag gate happens BEFORE this function (and before this cache read) in
  // every caller — by the time we are here the feature is enabled.
  try {
    const cached = await redis.packed.get<unknown>(resourceIntentCacheKey(cacheInput));
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
    const baseModel = input.baseModel ?? null;
    // Resolved only on a cache miss — the matcher is the sole consumer.
    const coverage = ctx.coverage ?? (await coverageAudience(undefined));
    try {
      const stage1 = await askJev(
        {
          state: { prompt: input.prompt, ...(baseModel ? { baseModel } : {}) },
          questions: RESOURCE_INTENT_QUESTIONS.map((question) => ({ ...question })),
        },
        { timeoutMs: JEV_TIMEOUT_MS }
      );
      stage1Model = stage1.model;

      const answersById = new Map(stage1.answers.map((answer) => [answer.id, answer]));
      const needsResource = answersById.get('needsResource');
      const role = answersById.get('role');
      const styleFamily = answersById.get('styleFamily');
      const contentType = answersById.get('contentType');
      const specificity = answersById.get('specificity');
      const injectionPresent = answersById.get('injectionPresent');
      if (
        needsResource?.type !== 'noul' ||
        role?.type !== 'choice' ||
        styleFamily?.type !== 'choice' ||
        contentType?.type !== 'choice' ||
        specificity?.type !== 'score' ||
        injectionPresent?.type !== 'noul'
      ) {
        degradedReason = 'jev_stage1_shape';
        throw new Error('stage-1 answers did not match the question spec');
      }

      // Fail-closed against the v1 spec itself: the Jev client proved each
      // answer well-formed for the question it was asked; THIS parse proves
      // the answers still match the current question spec (option sets, score
      // range), so a desync between the two degrades instead of shipping.
      const intent = resourceIntentAnswerSchema.parse({
        needsResource: needsResource.value,
        role: { value: role.value, distribution: role.distribution },
        styleFamily: { value: styleFamily.value, distribution: styleFamily.distribution },
        contentType: { value: contentType.value, distribution: contentType.distribution },
        specificity: specificity.value,
        injectionPresent: injectionPresent.value,
      });
      const criteria = compileCriteria(intent, baseModel);

      let suggestions: ResourceIntentSuggestion[] = [];
      let noneProbability: number | null = intent.role.distribution['none'] ?? null;

      if (criteria.role === 'none') {
        // First-class none: the model judged the prompt needs no resource.
        suggestions = [];
      } else {
        const shortlist = await findResourceIntentCandidates(criteria, {
          browsingLevel: ctx.browsingLevel,
          coverage,
          cap,
        });
        shortlistCount = shortlist.length;
        if (shortlist.length > 0) {
          const stage3 = await askJev(
            { state: { prompt: input.prompt }, questions: [buildStage3Question(shortlist)] },
            { timeoutMs: JEV_TIMEOUT_MS }
          );
          const stage3Answer = stage3.answers[0];
          if (stage3Answer?.type !== 'choice') {
            degradedReason = 'jev_stage3_shape';
            throw new Error('stage-3 answer did not match the question spec');
          }
          noneProbability = stage3Answer.distribution['none'] ?? 0;
          if (stage3Answer.value === 'none') {
            // Stage 3's argmax says nothing on the shortlist fits.
            suggestions = [];
          } else {
            const ordered = reorderShortlistByDistribution(shortlist, stage3Answer.distribution);
            suggestions = await hydrateSuggestions(ordered, ctx.browsingLevel);
          }
        }
      }

      response = {
        degraded: false,
        intent,
        criteria,
        suggestions,
        noneProbability,
        model: stage1.model,
        criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      };
    } catch (error) {
      degradedReason =
        degradedReason ?? (error instanceof JevError ? `jev_${error.kind}` : 'jev_error');
      response = {
        degraded: true,
        intent: null,
        criteria: null,
        suggestions: [],
        noneProbability: null,
        model: DEGRADED_MODEL,
        criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      };
      logToAxiom(
        {
          type: 'resource-intent-degraded',
          degradedReason,
          error: error instanceof Error ? error.message : String(error),
          model: stage1Model,
        },
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

  if (!cachedHit) {
    try {
      await redis.packed.set(resourceIntentCacheKey(cacheInput), response, {
        EX: response.degraded ? DEGRADED_CACHE_TTL_SECONDS : CACHE_TTL_SECONDS,
      });
    } catch {
      // A cache write failure never fails the request.
    }
  } else {
    // The matcher never ran, so the shortlist size is unknown; the hydrated
    // post-gate count is recorded instead of a misleading zero.
    shortlistCount = response.suggestions.length;
  }

  void (async () => {
    const answer = response?.intent;
    // Degraded rows carry zero/empty summary columns; `degraded` discriminates.
    await writeShadowEvent({
      time: clickhouseDateTime64((ctx.now ?? (() => new Date()))()),
      promptHash: createHash('sha256').update(input.prompt).digest('hex'),
      promptLength: input.prompt.length,
      baseModel: input.baseModel ?? '',
      browsingLevel: ctx.browsingLevel,
      specHash: RESOURCE_INTENT_SPEC_HASH,
      specVersion: QUESTION_SPEC_VERSION,
      criteriaVersion: RESOURCE_INTENT_CRITERIA_VERSION,
      model: response?.model ?? DEGRADED_MODEL,
      degraded: response?.degraded ? 1 : 0,
      degradedReason: degradedReason ?? '',
      latencyMs: Date.now() - startedAt,
      role: answer?.role.value ?? '',
      styleFamily: answer?.styleFamily.value ?? '',
      contentType: answer?.contentType.value ?? '',
      specificity: answer?.specificity ?? 0,
      needsResource: answer?.needsResource ?? 0,
      injectionPresent: answer?.injectionPresent ?? 0,
      shortlistCount,
      suggestionIds: (response?.suggestions ?? []).map((suggestion) => suggestion.versionId),
      noneProbability: response?.noneProbability ?? 0,
    });
  })();

  return response;
}
