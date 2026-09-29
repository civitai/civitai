import type { SearchParams } from 'meilisearch';

import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import {
  isTransientMeiliError,
  searchClient,
  searchWithSignal,
  withMeiliResourceSelect,
} from '~/server/meilisearch/client';
import {
  RESOURCE_INTENT_MAX_SHORTLIST,
  type ResourceIntentCriteria,
} from '~/server/schema/resource-intent.schema';
import { coverageFilter, versionGeneratableFor } from '~/shared/generation/coverage-fields';
import { and, eq, inArray, ne, not, or } from '~/shared/utils/meili-filter';
import { Flags } from '~/shared/utils/flags';
import { Availability, type ModelType } from '~/shared/utils/prisma/enums';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';

/**
 * Stage 2 of the resource-intent primitive: compile the versioned criteria into
 * a filtered, ordered query over the models_v9 index and expand the hits into a
 * deterministic, capped VERSION shortlist for Jev stage 3.
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

// One model usually contributes 1–3 baseModel-matching versions, so the search
// page is sized at twice the version cap (bounded by Meili's 1000-page limit);
// expansion below still caps the shortlist hard at `cap`.
const SEARCH_PAGE_MULTIPLIER = 2;
const SEARCH_PAGE_MAX = 500;

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
  const cap = Math.min(Math.max(1, Math.trunc(opts.cap)), RESOURCE_INTENT_MAX_SHORTLIST);
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

/**
 * Optional `ResourceInsight` quality re-rank (M2 seam). Stable: entries without
 * a score keep their popularity order after the scored ones. A no-op when the
 * map is empty (the state before the labeling pass has run).
 */
export function applyInsightRanking(
  entries: ResourceIntentShortlistEntry[],
  qualityByVersion?: Map<number, number>
): ResourceIntentShortlistEntry[] {
  if (!qualityByVersion?.size) return entries;
  return entries
    .map((entry, index) => ({ entry, index, quality: qualityByVersion.get(entry.versionId) }))
    .sort((a, b) => {
      const qa = a.quality ?? Number.NEGATIVE_INFINITY;
      const qb = b.quality ?? Number.NEGATIVE_INFINITY;
      if (qa !== qb) return qb - qa;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
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
    qualityByVersion?: Map<number, number>;
  }
): Promise<ResourceIntentShortlistEntry[]> {
  if (criteria.role === 'none') return [];
  const filter = buildResourceIntentFilter({
    modelTypes: criteria.modelTypes,
    baseModels: criteria.baseModel ? [criteria.baseModel] : null,
    browsingLevel: opts.browsingLevel,
    coverage: opts.coverage,
  });
  const hits = await searchShortlistModels(filter, opts.cap);
  const entries = expandShortlist(hits, {
    baseModels: criteria.baseModel ? [criteria.baseModel] : null,
    coverage: opts.coverage,
    cap: opts.cap,
  });
  return applyInsightRanking(entries, opts.qualityByVersion);
}
