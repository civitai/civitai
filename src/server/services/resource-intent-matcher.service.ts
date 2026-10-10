import type { SearchParams } from 'meilisearch';

import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import {
  isTransientMeiliError,
  searchClient,
  searchWithSignal,
  withMeiliResourceSelect,
} from '~/server/meilisearch/client';
import {
  clampResourceIntentCap,
  RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT,
  RESOURCE_INTENT_ROLE_OPTIONS,
  type ResourceIntentCriteria,
  type ResourceIntentRole,
  type ResourceIntentStyleFamily,
} from '~/server/schema/resource-intent.schema';
import {
  poolMergeBaseWidth,
  poolMergeModelIds,
  POOL_MERGE_COOC_LIST_MODELS,
} from '~/server/services/resource-intent-pool-merge';
import {
  loadResourceInsights,
  RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE,
  RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
  type ResourceIntentInsight,
} from '~/server/services/resource-insight';
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
 * Gates (brief §3.3), applied to the shortlist AND `basePool`. Jev output only orders
 * within them, never adds:
 *   - availability != Private (the index is published-only by construction)
 *   - model-level nsfwLevel bits intersected with the caller's browsing level
 *     (the authoritative maturity clamp is computed by the caller from the
 *     block token's maxBrowsingLevel — this filter never widens it)
 *   - canGenerate coverage (same indexed fields the resource picker filters on)
 *   - role→ModelType filter + caller-supplied baseModel compatibility
 *   - the hard-coded `celebrity` tag exclusion
 *
 * Filter conventions mirror `resource-select.service.ts` (same index, same
 * meili-filter builder).
 *
 * 🔴 The pool is seeded by popularity alone (`searchShortlistModels`); labels act only
 * through `applyInsightRanking`. Do not put role-filtered or quality-sorted documents back
 * into the seed: a role-filtered page fills the pool and evicts the popular model the user
 * attached (M3 study v2, docs/resource-intent-primitive.md).
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

/**
 * Pool width as a multiple of the response cap, so a candidate the seed placed
 * outside the shortlist can still be promoted into it.
 *
 * 🔴 The effective width is `min(cap * 2, RESOURCE_INTENT_MAX_SHORTLIST)`, which
 * starts shrinking at `cap = 128` and reaches 1x — i.e. reorder-the-visible-page
 * only — at the maximum accepted `limit` of 255. That is deliberate (the pool is
 * the work bound as well as the lookahead) but it means the widening is a
 * property of the DEFAULT cap of 50, not of every request.
 *
 * `clampResourceIntentCap` is therefore the ONE bound on the pool and on the seed
 * page's `limit` below — raising `RESOURCE_INTENT_MAX_SHORTLIST` to widen responses
 * also raises this re-rank's work bound, and the fetch bound with it. A second
 * ceiling here was deleted for being unreachable while that
 * constant stays under it; if it is ever raised past Meilisearch's own
 * `maxTotalHits`, a page silently truncates and the ceiling has to come back. The
 * one exception is `seedBasePool`'s deep page: a fixed
 * `RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT` fetch outside this bound, under the same
 * `maxTotalHits` caveat.
 */
const RERANK_POOL_MULTIPLIER = 2;

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
 * Expand model hits (already in seed order — see `searchShortlistModels`) into
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

// The insight shape, both confidence floors and `loadResourceInsights` now live in
// `./resource-insight.ts` — imported above, and deliberately NOT re-exported from here.
// A re-export was tried and removed in the same PR: its stated reason was that "existing
// callers" imported them from this path, and an enumeration of every importer of this
// module found none. The only consumer was one test's two constants, and two of the four
// re-exported names had no consumer through this path at all; both production consumers
// already import from the leaf directly. Import from `./resource-insight` — there is
// deliberately one path, not two.

const ROLE_MATCH_WEIGHT = 2;
const STYLE_MATCH_WEIGHT = 1;

type ResourceIntentWant = {
  role: ResourceIntentRole;
  styleFamily: ResourceIntentStyleFamily;
};

function insightBucket(insight: ResourceIntentInsight, want: ResourceIntentWant): number {
  // `other` means "none of the above" on both sides, so other↔other is not agreement.
  const styleMatch = want.styleFamily !== 'other' && insight.styleFamily === want.styleFamily;
  const agreement =
    (insight.role === want.role ? ROLE_MATCH_WEIGHT : 0) + (styleMatch ? STYLE_MATCH_WEIGHT : 0);
  // Each direction reads ITS OWN floor. The two constants are equal today, so this
  // is one branch in behaviour and two in structure — which is the point: the
  // directions were coupled through a single constant and the argument beside it
  // only ever covered promotion.
  if (agreement > 0) {
    return insight.confidence < RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE ? 0 : agreement;
  }
  if (insight.confidence < RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE) return 0;
  // 🔴 Demotion turns on the ROLE alone, and only on a role that is BOTH in this
  // build's taxonomy AND an actual role.
  //
  // Only the role, because only a recognised role is positive evidence the resource
  // is for something ELSE; an unrecognised `styleFamily` already fails the
  // comparison above, so checking it here would change nothing.
  //
  // Only a value this build knows, because `role`/`styleFamily` are TEXT versioned
  // with the label spec: a taxonomy edit supersedes every row's spec AND makes its
  // strings unmatchable in the same move, so demoting on one would bury the entire
  // labeled population (the catalogue's high-usage head) beneath the unlabeled
  // majority until a re-label pass caught up.
  //
  // And `none` is excluded even though it IS in the option list, because it is the
  // taxonomy's own "no role at all" — the labeller's way of saying it could not
  // place the resource, not evidence of a different purpose. Demoting on it would
  // make being LABELLED a penalty: a resource the pass could not classify would rank
  // below an identical one it never reached.
  //
  // ⚠️ That is the same INSTINCT as the style axis's `other` guard two lines up but
  // not the same rule, so do not read them as one: `other` is excluded from
  // AGREEMENT, `none` from DEMOTION. Each is guarded where it is reachable. A
  // declined style family cannot agree and the style axis has no demotion branch; a
  // `none` role cannot agree either, because `want.role` is never `none` — the
  // caller returns before this function on that role — so demotion is the only
  // branch it can reach. If that early return is ever relaxed, the agreement side
  // needs the same guard or `none` meeting `none` becomes the strongest single-axis
  // promotion out of two labels that both mean "could not place it".
  return insight.role !== 'none' &&
    (RESOURCE_INTENT_ROLE_OPTIONS as readonly string[]).includes(insight.role)
    ? -1
    : 0;
}

/**
 * Order the pool by how far each candidate's label agrees with what the request
 * asked for.
 *
 * This buckets rather than scores: a label that agrees promotes, a label at or
 * above the demote floor that disagrees demotes, and everything else — unlabeled,
 * or labeled below the floor for its direction — sits at a neutral bucket that
 * preserves the seed order exactly. An unlabeled candidate never sorts as if it had
 * scored zero, which would bury the unlabeled majority beneath any weakly-labeled
 * row.
 *
 * ⚠️ The stated JUSTIFICATION for bucketing used to be "only ~1% of eligible
 * versions carry a label", and that argument is RETRACTED — not because the figure
 * is wrong, but because it is the rate over a population this function never sees.
 * It is corpus-wide (~1%: 9,900 labeled of ~0.94M eligible versions). The pool
 * handed to this function is NOT a corpus sample: it is a top-by-thumbs-up page (see
 * `searchShortlistModels`), and the labeled set IS the catalogue's high-usage head —
 * the lowest `generationCount` among labeled versions is 46,798 — so coverage there
 * runs ~30-45x the corpus rate: 33.3% of the versions of the top 100 models by
 * thumbs-up (350 of 1,050), and ~45% restricted to the LoRA family (236 of 522). Those
 * two figures were measured on popularity-ordered populations without the gate filter,
 * so they approximate a pool rather than measure one.
 * ⚠️ Provenance, because none of this is reproducible from the tree: measured
 * against the primary Postgres database by the reviewer who raised the retraction
 * and twice independently by auditors, NOT by anything in this change. The queries
 * were not captured. Treat the figures as a three-way-agreeing external measurement
 * and re-run them before building on them.
 *
 * So bucketing is not held up here by labels being rare, and nothing here is a
 * fresh argument minted to replace it. What survives is the sentence immediately
 * above, which already stood before the retraction: a labeled and an unlabeled
 * candidate share no scale, so a scoring scheme would have to invent a score for
 * the unlabeled candidates, and the neutral band is how this ordering avoids
 * inventing one. That is a reason, not merely a property — the honest distinction
 * is that it was promoted from a CONSEQUENCE of the policy to the whole of what
 * holds it up, not that it is somehow argument-free. Whether buckets or scores
 * serve better at the in-pool coverage described above has never been tested, and
 * it is the first thing to revisit once the shadow table can grade the ordering
 * (see the closing condition in `docs/resource-intent-primitive.md`).
 *
 * 🔴 This returns a permutation, but its CALLER slices to the response cap, so on a
 * pool wider than the cap the ordering decides WHICH candidates reach stage 3 and not
 * only in what order. That is the point of the wider pool; it also means a promotion
 * is an eviction from the shortlist, and the candidate evicted may be an unlabeled one.
 * The response sees this only through stage 3's head; the fill is `basePool`.
 *
 * `qualityScore` separates candidates inside either labeled bucket, never for a
 * neutral one — reading it there would re-introduce exactly that burial, since there
 * is no quality score to compare an unlabeled candidate against.
 *
 * Tiebreaks on the seed order; `combineStage3Answers` (`resource-intent-stage3.ts`)
 * tiebreaks the same way on THIS function's output, and the pipeline's
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

/** No search client ⇒ no hits. */
async function searchShortlistModels(
  filter: string | null,
  poolCap: number
): Promise<ModelSearchIndexRecord[]> {
  return searchModelIndex({
    filter: filter ?? undefined,
    // 🔴 Popularity ONLY: no role filter and no quality key — see this module's header.
    sort: ['metrics.thumbsUpCount:desc'],
    // One document per targeted version, no multiplier. A document can still expand to
    // zero versions (the coverage and baseModel filters are nested-array matches), so the
    // pool can be narrower than `poolCap`.
    limit: poolCap,
  });
}

async function searchModelIndex(request: SearchParams): Promise<ModelSearchIndexRecord[]> {
  const client = searchClient;
  if (!client) return [];
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

/**
 * The first gate-passing version of each hit, one per model, in hit order, until `cap`
 * models. Same gates as `expandShortlist`, which it calls per hit.
 */
export function expandOneVersionPerModel(
  hits: ModelSearchIndexRecord[],
  opts: { baseModels: readonly string[] | null; coverage: ResourceIntentCoverage; cap: number }
): ResourceIntentShortlistEntry[] {
  const entries: ResourceIntentShortlistEntry[] = [];
  for (const hit of hits) {
    if (entries.length >= opts.cap) break;
    const [first] = expandShortlist([hit], { ...opts, cap: 1 });
    if (first) entries.push(first);
  }
  return entries;
}

type ResourceIntentSeed = {
  cap: number;
  poolCap: number;
  filter: string | null;
  baseModels: string[] | null;
  pool: ResourceIntentShortlistEntry[];
};

/** The candidate pool before any label is read, and the response cap it is later cut to. */
async function seedResourceIntentPool(
  criteria: Pick<ResourceIntentCriteria, 'modelTypes' | 'baseModel'>,
  opts: { browsingLevel: number; coverage: ResourceIntentCoverage; cap: number }
): Promise<ResourceIntentSeed> {
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
  const pool = expandShortlist(hits, { baseModels, coverage: opts.coverage, cap: poolCap });
  return { cap, poolCap, filter, baseModels, pool };
}

/**
 * The hybrid's fill, built exactly as the screen built its BASE pool: one
 * `RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT`-document page under the seed's filter and sort,
 * one version per model, the first `poolCap` models in popularity order. Always its own
 * query, so it does not rely on the seed page being a prefix of it.
 */
async function seedBasePool(
  seed: ResourceIntentSeed,
  coverage: ResourceIntentCoverage
): Promise<ResourceIntentShortlistEntry[]> {
  const deep = await searchShortlistModels(seed.filter, RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT);
  return expandOneVersionPerModel(deep, {
    baseModels: seed.baseModels,
    coverage,
    cap: seed.poolCap,
  });
}

/**
 * What `findResourceIntentCandidates` returns, as a RESULT OBJECT rather than a
 * bare array, so the fail-soft path below cannot be silent.
 *
 * 🔴 `insightFallback` exists because the fallback is otherwise indistinguishable
 * from success at the seam: the caller receives a well-formed, correctly-capped
 * shortlist in seed order and has no way to learn that the labels were never
 * read. That cost the caller its cache TTL decision — an unordered response was
 * cached for as long as a fully successful one. The TTL rule and the argument for
 * it live at `INSIGHT_FALLBACK_CACHE_TTL_SECONDS` in `resource-intent.service.ts`;
 * this comment deliberately does not restate the values.
 */
export type ResourceIntentMatchResult = {
  entries: ResourceIntentShortlistEntry[];
  /**
   * `true` ⇒ the `ResourceInsight` read FAILED on this call and `entries` is the
   * seed (popularity) order, with no per-version label
   * ordering applied.
   *
   * `false` is the narrow claim that no such failure happened — NOT that the
   * ordering changed anything. An empty pool, a pool with no labeled version, and
   * a pool every label left neutral all report `false`. Separating those is the
   * shadow-table work in `docs/resource-intent-primitive.md`'s closing condition,
   * of whose two clauses this flag supplies ONE CASE of ONE: "the ordering could
   * not run". It says nothing about whether the ordering changed the returned
   * slice, and nothing about an ordering that ran with nothing to order.
   */
  insightFallback: boolean;
  /**
   * Pool versions whose label the re-rank PROMOTES (agrees on role or style family, at or
   * above the promote floor). `0` ⇒ the ordering had nothing to promote — including on a
   * fallback, where no label was read. The M3 study's positive control reads it.
   */
  promotableVersions: number;
  /**
   * The whole pool this call ranked, in seed order. The M3 study's POPULARITY arm is this
   * pool cut to the cap, so the two arms share one seed.
   */
  pool: ResourceIntentShortlistEntry[];
  /** The hybrid list's popularity fill — see `seedBasePool`. Independent of the label read. */
  basePool: ResourceIntentShortlistEntry[];
};

export async function findResourceIntentCandidates(
  criteria: ResourceIntentCriteria,
  opts: {
    browsingLevel: number;
    coverage: ResourceIntentCoverage;
    cap: number;
  }
): Promise<ResourceIntentMatchResult> {
  if (criteria.role === 'none') {
    return { entries: [], insightFallback: false, promotableVersions: 0, pool: [], basePool: [] };
  }
  const seed = await seedResourceIntentPool(criteria, opts);
  const { cap, pool } = seed;
  const [basePool, insightRead] = await Promise.all([
    seedBasePool(seed, opts.coverage),
    loadResourceInsights(pool.map((entry) => entry.versionId)).then(
      (insights) => ({ insights }),
      // Settled here, not in a try: the base pool must not wait on (or fail with) the label read.
      (error: unknown) => ({ error })
    ),
  ]);

  if ('error' in insightRead) {
    const { error } = insightRead;
    // The caller's only other option is a fully degraded response, so an
    // unreachable label table costs the ordering refinement and nothing else —
    // but it is REPORTED, not swallowed. The log alone reached nobody who could
    // act on it inside the request: the caller decides this response's cache TTL,
    // and a silent fallback got the full-success hour.
    //
    // ⚠️ This fallback is DELIBERATELY broader than the repo's other fail-soft reads
    // of a hand-applied table — `isMissingTableError` in
    // `src/server/services/blocks/app-access.service.ts` and `isUndefinedTable` in
    // `src/server/services/apps/app-storage.service.ts` both swallow only the
    // missing-relation error, on the argument that anything wider is a permanent
    // silent-zero generator. Wider here because this read refines an ordering
    // rather than deciding access, so there is no silent zero to generate: every
    // candidate is still returned, in the order the index gave them. The cost of
    // the breadth is that a PERMANENT fault (a query bug, a half-applied
    // migration that renamed a column) reports as a fallback forever instead of
    // surfacing — which is exactly what makes the fallback TTL in
    // `resource-intent.service.ts` worth reading before the flag opens.
    logToAxiom(
      {
        type: 'resource-intent-insight-read-failed',
        error: error instanceof Error ? error.message : String(error),
      },
      'temp-search'
    ).catch(() => undefined);
    return {
      entries: pool.slice(0, cap),
      insightFallback: true,
      promotableVersions: 0,
      pool,
      basePool,
    };
  }
  const { insights } = insightRead;
  return {
    entries: applyInsightRanking(pool, insights, criteria).slice(0, cap),
    insightFallback: false,
    promotableVersions: pool.filter((entry) => {
      const insight = insights.get(entry.versionId);
      return insight !== undefined && insightBucket(insight, criteria) > 0;
    }).length,
    pool,
    basePool,
  };
}

/**
 * The POOL_MERGE arm's list, exactly as the co-occurrence screen gated and merged it.
 *
 * Co-occurrence: the candidates (best first) under the seed's filter AND `id IN candidates`, one
 * page as wide as the candidate list and unsorted, re-sorted by candidate rank, one version per
 * model. BASE: `seedBasePool`'s page, one version per model, `poolMergeBaseWidth(cap)` wide.
 */
export async function findPoolMergeCandidates(
  criteria: ResourceIntentCriteria,
  opts: {
    browsingLevel: number;
    coverage: ResourceIntentCoverage;
    cap: number;
    coocCandidates: readonly number[];
  }
): Promise<{ entries: ResourceIntentShortlistEntry[]; coocGated: number }> {
  if (criteria.role === 'none') return { entries: [], coocGated: 0 };
  const cap = clampResourceIntentCap(opts.cap);
  const cands = opts.coocCandidates;
  const baseModels = criteria.baseModel ? [criteria.baseModel] : null;
  const filter = buildResourceIntentFilter({
    modelTypes: criteria.modelTypes,
    baseModels,
    browsingLevel: opts.browsingLevel,
    coverage: opts.coverage,
  });
  const [deep, hits] = await Promise.all([
    searchShortlistModels(filter, RESOURCE_INTENT_BASE_DEEP_PAGE_LIMIT),
    cands.length
      ? searchModelIndex({
          filter: and(filter, inArray('id', cands)) ?? undefined,
          limit: cands.length,
        })
      : Promise.resolve([]),
  ]);
  const basePool = expandOneVersionPerModel(deep, {
    baseModels,
    coverage: opts.coverage,
    cap: poolMergeBaseWidth(cap),
  });
  const candRank = new Map(cands.map((id, i) => [id, i]));
  const docs = [...hits].sort((x, y) => (candRank.get(x.id) ?? 1e9) - (candRank.get(y.id) ?? 1e9));
  const gated = cands.length
    ? expandOneVersionPerModel(docs, { baseModels, coverage: opts.coverage, cap: cands.length })
    : [];
  const coocList = gated.slice(0, POOL_MERGE_COOC_LIST_MODELS);
  // A model on both lists expands from the same document through the same gates: same version.
  const byModel = new Map([...basePool, ...coocList].map((e) => [e.modelId, e]));
  const entries = poolMergeModelIds(
    coocList.map((e) => e.modelId),
    basePool.map((e) => e.modelId),
    cap
  ).map((id) => byModel.get(id) as ResourceIntentShortlistEntry);
  return { entries, coocGated: gated.length };
}
