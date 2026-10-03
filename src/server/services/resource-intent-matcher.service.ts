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
  clampResourceIntentCap,
  RESOURCE_INTENT_ROLE_OPTIONS,
  RESOURCE_INTENT_STYLE_FAMILY_OPTIONS,
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

// 🔴 ONE DOCUMENT PER TARGETED VERSION, derived from the POOL width rather than
// the response cap, and no multiplier on top. A model contributes at least one
// matching version, so a page this wide can always fill the pool, and measured
// against the live index a 100-document page filled a 100-version pool in every
// populated role x baseModel combination while CONSUMING only 10-48 of those
// documents. The 2x that used to sit here fetched and parsed the other half for
// nothing: it added zero pool members anywhere and cost 1.6-2.6x the response
// payload and JSON.parse, plus roughly double the index's own processing time on a
// Meilisearch shared with the resource picker.
const SEARCH_PAGE_MAX = 500;

/**
 * Pool width as a multiple of the response cap, so a candidate the popularity
 * seed placed outside the response can still be promoted into it.
 *
 * 🔴 The effective width is `min(cap * 2, RESOURCE_INTENT_MAX_SHORTLIST)`, which
 * starts shrinking at `cap = 128` and reaches 1x — i.e. reorder-the-visible-page
 * only — at the maximum accepted `limit` of 255. That is deliberate (the pool is
 * the work bound as well as the lookahead) but it means the widening is a
 * property of the DEFAULT cap of 50, not of every request.
 */
const RERANK_POOL_MULTIPLIER = 2;

/**
 * Both the page and the pool are bounded by this, through `clampResourceIntentCap`
 * — so raising `RESOURCE_INTENT_MAX_SHORTLIST` to widen responses also raises the
 * re-rank's work bound.
 */

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
  const cap = clampResourceIntentCap(opts.cap);
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
 * `ResourceInsight.confidence` is the WEAKEST of a row's four label judgments —
 * including the `contentType` one this ordering never reads — and the written
 * distribution is p50 0.43 / mean 0.44 with only 3.4% of rows at or above 0.70.
 * So a 0.70 floor would discard ~96.6% of the labels and leave this ordering
 * inert; 0.30 is the measured ~12.8th percentile.
 */
export const RESOURCE_INSIGHT_MIN_CONFIDENCE = 0.3;

const ROLE_MATCH_WEIGHT = 2;
const STYLE_MATCH_WEIGHT = 1;

type ResourceIntentWant = {
  role: ResourceIntentRole;
  styleFamily: ResourceIntentStyleFamily;
};

/**
 * `role` and `styleFamily` are TEXT, versioned with the label spec, so a stored row
 * can hold a value this build's taxonomy no longer contains.
 *
 * Only the `role` narrowing changes behaviour (it is what the demotion rule reads).
 * On `styleFamily` it is compile-time only — an unrecognised string compares false
 * against `want.styleFamily` exactly as `null` does — and it is kept so both sides
 * of that comparison are the union type rather than `string` against a union, which
 * type-checks whatever the left side can hold. Do not write a behavioural test for
 * the style half; there is nothing to observe.
 */
function knownValue<T extends string>(options: readonly T[], stored: string): T | null {
  return (options as readonly string[]).includes(stored) ? (stored as T) : null;
}

function insightBucket(insight: ResourceIntentInsight, want: ResourceIntentWant): number {
  if (insight.confidence < RESOURCE_INSIGHT_MIN_CONFIDENCE) return 0;
  const role = knownValue(RESOURCE_INTENT_ROLE_OPTIONS, insight.role);
  const styleFamily = knownValue(RESOURCE_INTENT_STYLE_FAMILY_OPTIONS, insight.styleFamily);
  // `other` means "none of the above" on both sides, so other↔other is not agreement.
  const styleMatch = want.styleFamily !== 'other' && styleFamily === want.styleFamily;
  const agreement =
    (role === want.role ? ROLE_MATCH_WEIGHT : 0) + (styleMatch ? STYLE_MATCH_WEIGHT : 0);
  if (agreement > 0) return agreement;
  // 🔴 Demotion turns on the ROLE alone, because only a recognised role is positive
  // evidence that the resource is for something ELSE; an unrecognised `styleFamily`
  // beside a recognised disagreeing role does not rescue it. A taxonomy edit
  // supersedes every stored row's spec AND makes its strings unmatchable in the same
  // move, so demoting on a value this build cannot interpret would bury the entire
  // labeled population — the catalogue's high-usage head — beneath the unlabeled
  // majority, silently, until a re-label pass caught up.
  return role !== null ? -1 : 0;
}

/**
 * Order the pool by how far each candidate's label agrees with what the request
 * asked for.
 *
 * Only ~1% of eligible versions carry a label, so this buckets rather than
 * scores: a label that agrees promotes, a confident label that disagrees demotes,
 * and everything else — unlabeled, or labeled below the confidence floor — sits
 * at a neutral bucket that preserves the seed order exactly. An unlabeled candidate
 * never sorts as if it had scored zero, which would bury the unlabeled majority
 * beneath any weakly-labeled row.
 *
 * 🔴 This returns a permutation, but its CALLER slices to the response cap, so on a
 * pool wider than the cap the ordering decides WHICH candidates are returned and not
 * only in what order. That is the point of the wider pool; it also means a promotion
 * is an eviction, and the candidate evicted may be an unlabeled one.
 *
 * `qualityScore` separates candidates inside either labeled bucket, never for a
 * neutral one — reading it there would re-introduce exactly that burial, since there
 * is no quality score to compare an unlabeled candidate against.
 *
 * Tiebreaks on the seed order; `reorderShortlistByDistribution` in the calling
 * service tiebreaks the same way on THIS function's output, and the pipeline's
 * determinism claim needs both.
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
 * 🔴 `stale: false` is a floor, not a freshness guarantee. Nothing in this repo
 * sets `stale = true` — the migration describes that flip as a manual step of a
 * label-spec bump — so today the clause excludes no row, and `specHash` is
 * deliberately NOT compared: filtering on it would make the whole ordering inert
 * from the moment a spec moves until a manual, vendor-spend-gated re-label pass
 * finished, and the table was designed so superseded rows stay readable. The
 * harm a superseded row could do is handled in `insightBucket` instead, by
 * refusing to demote on a value this build cannot interpret. What is NOT covered
 * either way is a spec that keeps an option's spelling and changes its meaning;
 * that one needs the manual flip.
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
  poolCap: number
): Promise<ModelSearchIndexRecord[]> {
  const client = searchClient;
  if (!client) return [];
  const request: SearchParams = {
    filter: filter ?? undefined,
    sort: ['metrics.thumbsUpCount:desc'],
    limit: Math.min(poolCap, SEARCH_PAGE_MAX),
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
  const cap = clampResourceIntentCap(opts.cap);
  const poolCap = clampResourceIntentCap(cap * RERANK_POOL_MULTIPLIER);
  const baseModels = criteria.baseModel ? [criteria.baseModel] : null;
  const filter = buildResourceIntentFilter({
    modelTypes: criteria.modelTypes,
    baseModels,
    browsingLevel: opts.browsingLevel,
    coverage: opts.coverage,
  });
  const hits = await searchShortlistModels(filter, poolCap);
  const pool = expandShortlist(hits, {
    baseModels,
    coverage: opts.coverage,
    cap: poolCap,
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
