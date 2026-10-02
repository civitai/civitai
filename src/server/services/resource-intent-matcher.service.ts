import type { SearchParams } from 'meilisearch';

import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  isTransientMeiliError,
  searchClient,
  searchWithSignal,
  withMeiliResourceSelect,
} from '~/server/meilisearch/client';
import {
  RESOURCE_INTENT_MAX_SHORTLIST,
  type ResourceIntentCriteria,
  type ResourceIntentRole,
  type ResourceIntentStyleFamily,
} from '~/server/schema/resource-intent.schema';
import { coverageFilter, versionGeneratableFor } from '~/shared/generation/coverage-fields';
import { and, eq, inArray, ne, not, or } from '~/shared/utils/meili-filter';
import { Flags } from '~/shared/utils/flags';
import { Availability, type ModelType } from '~/shared/utils/prisma/enums';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';

/**
 * Stage 2 of the resource-intent primitive: compile the versioned criteria into
 * a filtered query over the models_v9 index, expand the hits into a
 * deterministic VERSION pool, order that pool against the `ResourceInsight`
 * labels, and return a capped shortlist for Jev stage 3.
 *
 * Gates (brief §3.3) — Jev output can reorder/drop within this set, never add:
 *   - availability != Private (the index is published-only by construction)
 *   - model-level nsfwLevel bits intersected with the caller's browsing level
 *     (the authoritative maturity clamp is computed by the caller from the
 *     block token's maxBrowsingLevel — this filter never widens it)
 *   - canGenerate coverage (same indexed fields the resource picker filters on)
 *   - role→ModelType filter + caller-supplied baseModel compatibility
 *   - the hard-coded `celebrity` tag exclusion
 *
 * Filter conventions mirror `resource-select.service.ts` (same index, same
 * meili-filter builder, same popularity sort).
 *
 * The candidate POOL is still seeded by popularity, because no insight field is
 * projected into the search index; the labels decide the ORDER within the pool.
 * The seed reaches `applyInsightRanking` only as the tiebreak index, so moving
 * the seed off `metrics.thumbsUpCount:desc` later replaces `searchShortlistModels`
 * without touching the re-rank.
 */

export type ResourceIntentCoverage = { next: boolean; member: boolean };

export type ResourceIntentShortlistEntry = {
  versionId: number;
  modelId: number;
  modelName: string;
  versionName: string;
  baseModel: string;
  modelType: string;
  thumbsUpCount: number;
};

// One model usually contributes 1–3 baseModel-matching versions, so a page of
// twice the response cap covers the re-rank pool (also twice the cap) without
// widening the query; expansion below still caps the pool hard.
const SEARCH_PAGE_MULTIPLIER = 2;
const SEARCH_PAGE_MAX = 500;

/**
 * Pool width as a multiple of the response cap. The pool is what gets re-ranked,
 * so a candidate the popularity seed placed outside the cap can still be promoted
 * into the response — without it this would only ever reorder the visible page.
 */
const RERANK_POOL_MULTIPLIER = 2;

function clampShortlistCap(cap: number): number {
  return Math.min(Math.max(1, Math.trunc(cap)), RESOURCE_INTENT_MAX_SHORTLIST);
}

export function buildResourceIntentFilter({
  modelTypes,
  baseModels,
  browsingLevel,
  coverage,
}: {
  modelTypes: readonly ModelType[] | null;
  baseModels: readonly string[] | null;
  browsingLevel: number;
  coverage: ResourceIntentCoverage;
}): string | null {
  const typeClauses = modelTypes?.map((type) =>
    baseModels?.length
      ? and(eq('type', type), inArray('versions.baseModel', baseModels))
      : eq('type', type)
  );

  return and(
    ne('availability', Availability.Private),
    inArray('nsfwLevel', Flags.instanceToArray(browsingLevel)),
    coverageFilter({ canGenerate: true, coverageNext: coverage.next, member: coverage.member }),
    typeClauses?.length ? or(...typeClauses) : null,
    baseModels?.length ? inArray('versions.baseModel', baseModels) : null,
    not(eq('tags.name', 'celebrity'))
  );
}

/**
 * Expand model hits (already popularity-ordered by the Meili sort) into
 * version-level shortlist entries. Deterministic: hits in returned order,
 * versions in stored order, hard cap, no duplicates.
 */
export function expandShortlist(
  hits: ModelSearchIndexRecord[],
  opts: {
    baseModels: readonly string[] | null;
    coverage: ResourceIntentCoverage;
    cap: number;
  }
): ResourceIntentShortlistEntry[] {
  const cap = clampShortlistCap(opts.cap);
  const entries: ResourceIntentShortlistEntry[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    if (entries.length >= cap) break;
    for (const version of hit.versions) {
      if (entries.length >= cap) break;
      if (seen.has(version.id)) continue;
      if (opts.baseModels?.length && !opts.baseModels.includes(version.baseModel)) continue;
      if (
        !versionGeneratableFor(version, {
          coverageNext: opts.coverage.next,
          member: opts.coverage.member,
          isCheckpoint: hit.type === 'Checkpoint',
        })
      ) {
        continue;
      }
      seen.add(version.id);
      entries.push({
        versionId: version.id,
        modelId: hit.id,
        modelName: hit.name,
        versionName: version.name,
        baseModel: version.baseModel,
        modelType: hit.type,
        thumbsUpCount: hit.metrics?.thumbsUpCount ?? 0,
      });
    }
  }
  return entries;
}

export type ResourceIntentInsight = {
  role: string;
  styleFamily: string;
  qualityScore: number;
  confidence: number;
};

/**
 * `ResourceInsight.confidence` is the WEAKEST of a row's four label judgments,
 * and the written distribution is p50 0.43 / mean 0.44 with only 3.4% of rows at
 * or above 0.70 — so a 0.70 floor would discard ~96.6% of the labels and leave
 * this ordering inert. 0.30 is the measured ~12.8th percentile and still roughly
 * twice the 1-in-9 a uniform-random role choice would score.
 */
export const RESOURCE_INSIGHT_MIN_CONFIDENCE = 0.3;

const ROLE_MATCH_WEIGHT = 2;
const STYLE_MATCH_WEIGHT = 1;

type ResourceIntentWant = {
  role: ResourceIntentRole;
  styleFamily: ResourceIntentStyleFamily;
};

function insightBucket(insight: ResourceIntentInsight, want: ResourceIntentWant): number {
  if (insight.confidence < RESOURCE_INSIGHT_MIN_CONFIDENCE) return 0;
  // `other` means "none of the above" on both sides, so other↔other is not agreement.
  const styleMatch = want.styleFamily !== 'other' && insight.styleFamily === want.styleFamily;
  const agreement =
    (insight.role === want.role ? ROLE_MATCH_WEIGHT : 0) + (styleMatch ? STYLE_MATCH_WEIGHT : 0);
  return agreement > 0 ? agreement : -1;
}

/**
 * Order the pool by how far each candidate's label agrees with what the request
 * asked for.
 *
 * Only ~1% of eligible versions carry a label, so this buckets rather than
 * scores: a label that agrees promotes, a confident label that disagrees demotes,
 * and everything else — unlabeled, or labeled below the confidence floor — sits
 * at a neutral bucket that preserves the seed order exactly. No candidate is
 * dropped, and an unlabeled one never sorts as if it had scored zero, which would
 * bury the unlabeled majority beneath any weakly-labeled row.
 *
 * `qualityScore` separates candidates only inside a labeled bucket. Reading it
 * for a neutral one would re-introduce exactly that burial, since there is no
 * quality score to compare an unlabeled candidate against.
 */
export function applyInsightRanking(
  entries: ResourceIntentShortlistEntry[],
  insights: Map<number, ResourceIntentInsight>,
  want: ResourceIntentWant
): ResourceIntentShortlistEntry[] {
  return entries
    .map((entry, index) => {
      const insight = insights.get(entry.versionId);
      const bucket = insight ? insightBucket(insight, want) : 0;
      return {
        entry,
        index,
        bucket,
        quality: insight && bucket !== 0 ? insight.qualityScore : 0,
      };
    })
    .sort((a, b) => b.bucket - a.bucket || b.quality - a.quality || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * `stale` rows were written under a superseded label spec and are queued for a
 * re-label, so they describe nothing current — dropped here rather than scored
 * down, which is what the `specHash`/`stale` pair exists for.
 */
export async function loadResourceInsights(
  versionIds: number[]
): Promise<Map<number, ResourceIntentInsight>> {
  if (!versionIds.length) return new Map();
  const rows = await dbRead.resourceInsight.findMany({
    where: { modelVersionId: { in: versionIds }, stale: false },
    select: {
      modelVersionId: true,
      role: true,
      styleFamily: true,
      qualityScore: true,
      confidence: true,
    },
  });
  return new Map(rows.map((row) => [row.modelVersionId, row]));
}

async function searchShortlistModels(
  filter: string | null,
  cap: number
): Promise<ModelSearchIndexRecord[]> {
  const client = searchClient;
  if (!client) return [];
  const request: SearchParams = {
    filter: filter ?? undefined,
    sort: ['metrics.thumbsUpCount:desc'],
    limit: Math.min(Math.max(cap * SEARCH_PAGE_MULTIPLIER, cap), SEARCH_PAGE_MAX),
  };
  try {
    const results = await withMeiliResourceSelect(
      (searchSignal) =>
        searchWithSignal<ModelSearchIndexRecord>(
          client.index(MODELS_SEARCH_INDEX),
          '',
          request,
          searchSignal
        ),
      {}
    );
    return results.hits;
  } catch (err) {
    if (isTransientMeiliError(err)) {
      throw new Error(`Resource-intent model search temporarily unavailable: ${String(err)}`);
    }
    throw err;
  }
}

export async function findResourceIntentCandidates(
  criteria: ResourceIntentCriteria,
  opts: {
    browsingLevel: number;
    coverage: ResourceIntentCoverage;
    cap: number;
  }
): Promise<ResourceIntentShortlistEntry[]> {
  if (criteria.role === 'none') return [];
  const cap = clampShortlistCap(opts.cap);
  const baseModels = criteria.baseModel ? [criteria.baseModel] : null;
  const filter = buildResourceIntentFilter({
    modelTypes: criteria.modelTypes,
    baseModels,
    browsingLevel: opts.browsingLevel,
    coverage: opts.coverage,
  });
  const hits = await searchShortlistModels(filter, cap);
  const pool = expandShortlist(hits, {
    baseModels,
    coverage: opts.coverage,
    cap: cap * RERANK_POOL_MULTIPLIER,
  });

  let insights: Map<number, ResourceIntentInsight>;
  try {
    insights = await loadResourceInsights(pool.map((entry) => entry.versionId));
  } catch (error) {
    // The caller's only other option is a fully degraded response, so an
    // unreachable label table costs the ordering refinement and nothing else.
    logToAxiom(
      {
        type: 'resource-intent-insight-read-failed',
        error: error instanceof Error ? error.message : String(error),
      },
      'temp-search'
    ).catch(() => undefined);
    return pool.slice(0, cap);
  }
  return applyInsightRanking(pool, insights, criteria).slice(0, cap);
}
