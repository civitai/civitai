import { uniqBy } from 'lodash-es';
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
  RESOURCE_INTENT_ROLE_OPTIONS,
  type ResourceIntentCriteria,
  type ResourceIntentRole,
  type ResourceIntentStyleFamily,
} from '~/server/schema/resource-intent.schema';
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
 * meili-filter builder) — but NOT the same sort any more: see below.
 *
 * 🔴 The candidate POOL IS SEEDED BY THE REQUESTED PURPOSE FIRST, then by popularity
 * (`searchShortlistModels`). Up to two pages over the same gate filter, merged purpose
 * page first:
 *   - PURPOSE: the gate filter AND `insight.role = <criteria.role>`, sorted
 *     `insight.qualityScore:desc` then `metrics.thumbsUpCount:desc`;
 *   - POPULARITY: the gate filter alone, sorted `metrics.thumbsUpCount:desc` — the
 *     pre-insight seed. Fetched ONLY when the purpose page came back short of the pool
 *     width, and then it fills whatever the purpose page left empty.
 * Duplicates (a purpose hit that is also popular) keep their purpose-page position.
 *
 * Why not one sort. The previous seed was a single sort, quality first and thumbs
 * second, with no role filter, so it ordered labeled models by quality REGARDLESS of
 * what they are for. In a busy type x baseModel cell the labeled models of other
 * purposes outnumber the pool width, so that seed returned almost none for the
 * requested purpose (measured figures: docs/resource-intent-primitive.md), and the
 * re-rank cannot recover from it — it only permutes the pool it is handed.
 *
 * Inside the purpose page every hit carries a quality score — `role` and `qualityScore`
 * are projected together from one label row, or are both null — so there
 * `metrics.thumbsUpCount:desc` is only a tiebreak between equal scores. A role with few
 * labeled matches simply yields a short purpose page, and the popularity page fills the
 * rest of the pool.
 *
 * ⚠️ KNOWN LIMITATION — the purpose page cannot filter on label CONFIDENCE. The index
 * carries the role of each model's best-scoring version among those that cleared
 * `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` when the document was written
 * (`modelInsightProjection`), but not the confidence itself; projecting it means
 * rewriting every document (a full index reset). So a role match at the bare floor is
 * seeded exactly like a confident one. Nor is the pooled version always the one the
 * role was projected from: a model's other versions, a row re-labelled since the
 * document was written, or a floor moved since, can each reach `insightBucket` with a
 * label that does not agree or sits below the floor for its direction — and the re-rank
 * then leaves it neutral or demotes it as for any other candidate. 🔴 A NEUTRAL one keeps
 * its seed position within the neutral bucket, though: such a version (say an unlabeled
 * version on the requested base model, of a model whose role came from a version on
 * another) sorts ahead of every unlabeled, neutral or demoted fill candidate — but a fill
 * version promoted on role OR on style family alone still outranks it.
 *
 * `applyInsightRanking` permutes the pool it is handed and tiebreaks on the seed index
 * (the merged purpose-then-popularity order).
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
 * outside the response can still be promoted into it.
 *
 * 🔴 The effective width is `min(cap * 2, RESOURCE_INTENT_MAX_SHORTLIST)`, which
 * starts shrinking at `cap = 128` and reaches 1x — i.e. reorder-the-visible-page
 * only — at the maximum accepted `limit` of 255. That is deliberate (the pool is
 * the work bound as well as the lookahead) but it means the widening is a
 * property of the DEFAULT cap of 50, not of every request.
 *
 * `clampResourceIntentCap` is therefore the ONE bound on the pool and on each seed
 * page's `limit` below — raising `RESOURCE_INTENT_MAX_SHORTLIST` to widen responses
 * also raises this re-rank's work bound, and the fetch bound with it (up to two
 * pages). A second ceiling here was deleted for being unreachable while that
 * constant stays under it; if it is ever raised past Meilisearch's own
 * `maxTotalHits`, a page silently truncates and the ceiling has to come back.
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
 * handed to this function is NOT a corpus sample. Its purpose-seeded head is
 * labeled by construction: every model there was matched on a projected
 * `insight.role` (see `searchShortlistModels`), although a matched model's OTHER
 * versions may carry no row. Its popularity-filled tail is a top-by-thumbs-up page,
 * and the labeled set IS the catalogue's high-usage head — the lowest
 * `generationCount` among labeled versions is 46,798 — so coverage there runs
 * ~30-45x the corpus rate: 33.3% of the versions of the top 100 models by thumbs-up
 * (350 of 1,050), and ~45% restricted to the LoRA family (236 of 522). Those two
 * figures were measured on popularity-ordered populations, before the purpose-first
 * seed existed, so they describe the tail and say nothing about the pool as a whole.
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
 * The two seed pages `searchShortlistModels` fetches, as data so the query shape is
 * testable without a search backend. See this module's header for why there are two.
 *
 * 🔴 `insight.role` is FILTERED here and never sorted: it is filterable-only by design
 * (`~/server/search-index/filterable-attributes.ts`). Both pages share `limit`; the
 * merge truncates their union to the same width.
 */
export function buildResourceIntentSeedQueries({
  filter,
  role,
  poolCap,
}: {
  filter: string | null;
  role: ResourceIntentRole;
  poolCap: number;
}): { purpose: SearchParams; popularity: SearchParams } {
  return {
    purpose: {
      filter: and(filter, eq('insight.role', role)) ?? undefined,
      // Quality first; thumbs only tiebreaks, since every hit on this page carries a
      // score (role and score are projected from one row, or are both null).
      sort: ['insight.qualityScore:desc', 'metrics.thumbsUpCount:desc'],
      limit: poolCap,
    },
    popularity: {
      filter: filter ?? undefined,
      // 🔴 Popularity ONLY — no quality key. A quality-first sort here re-creates the
      // defect the purpose page exists to fix: in a busy cell the fill would again be
      // labeled-by-quality models for OTHER purposes, ahead of every unlabeled one.
      sort: ['metrics.thumbsUpCount:desc'],
      limit: poolCap,
    },
  };
}

/**
 * Merge the two seed pages: purpose hits first, then popularity hits, each in its
 * own order, deduped by MODEL id (a model on both pages keeps its purpose-page
 * position), truncated to `poolCap` documents — the same document width the single
 * seed page had, so `expandShortlist` is handed a pool bounded as before.
 */
export function mergeSeedHits(
  purpose: readonly ModelSearchIndexRecord[],
  popularity: readonly ModelSearchIndexRecord[],
  poolCap: number
): ModelSearchIndexRecord[] {
  // `uniqBy` keeps the FIRST occurrence, which is what gives the purpose page precedence.
  return uniqBy([...purpose, ...popularity], 'id').slice(0, poolCap);
}

async function searchShortlistModels(
  filter: string | null,
  role: ResourceIntentRole,
  poolCap: number
): Promise<ModelSearchIndexRecord[]> {
  const client = searchClient;
  if (!client) return [];
  // 🔴 Each page asks for `poolCap` documents — one per targeted version, no multiplier.
  // A document USUALLY expands to at least one matching version, but not always: the
  // coverage and baseModel filters are nested-array matches, so a document can match on
  // two different versions and expand to zero. The merged pool is at most `poolCap`
  // documents. The FETCH is one page (≤ poolCap documents) when the purpose page comes
  // back full, and two sequential pages (≤ 2 x poolCap documents, two round trips) when it
  // comes back short — so an index that is slow but answering can hold the seed for up to
  // 2 x MEILI_RESOURCE_SELECT_TIMEOUT_MS (20s at the 10s default). Whether this width still fills the pool under the purpose-first
  // order has not been re-swept.
  const { purpose, popularity } = buildResourceIntentSeedQueries({ filter, role, poolCap });
  const search = (request: SearchParams) =>
    withMeiliResourceSelect(
      (searchSignal) =>
        searchWithSignal<ModelSearchIndexRecord>(
          client.index(MODELS_SEARCH_INDEX),
          '',
          request,
          searchSignal
        ),
      {}
    );
  try {
    // One call per page rather than a multi-search: nothing in this repo wraps
    // `multiSearch` with the undelivered-body guard `searchWithSignal` carries. Either
    // page failing fails the seed — there is deliberately no popularity-only fallback, so
    // an index that cannot answer the purpose page fails loudly.
    const purposeResults = await search(purpose);
    // The fill is requested at the full width, not `poolCap - purpose.length`: the merge
    // drops popularity hits already on the purpose page, so a narrower page could underfill.
    if (purposeResults.hits.length >= poolCap) {
      return mergeSeedHits(purposeResults.hits, [], poolCap);
    }
    const popularityResults = await search(popularity);
    return mergeSeedHits(purposeResults.hits, popularityResults.hits, poolCap);
  } catch (err) {
    if (isTransientMeiliError(err)) {
      throw new Error(`Resource-intent model search temporarily unavailable: ${String(err)}`);
    }
    throw err;
  }
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
   * seed order (purpose page, then popularity fill), with no per-version label
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
};

export async function findResourceIntentCandidates(
  criteria: ResourceIntentCriteria,
  opts: {
    browsingLevel: number;
    coverage: ResourceIntentCoverage;
    cap: number;
  }
): Promise<ResourceIntentMatchResult> {
  if (criteria.role === 'none') return { entries: [], insightFallback: false };
  const cap = clampResourceIntentCap(opts.cap);
  const poolCap = clampResourceIntentCap(cap * RERANK_POOL_MULTIPLIER);
  const baseModels = criteria.baseModel ? [criteria.baseModel] : null;
  const filter = buildResourceIntentFilter({
    modelTypes: criteria.modelTypes,
    baseModels,
    browsingLevel: opts.browsingLevel,
    coverage: opts.coverage,
  });
  const hits = await searchShortlistModels(filter, criteria.role, poolCap);
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
    // unreachable label table costs the ordering refinement and nothing else —
    // but it is REPORTED, not swallowed. The log alone reached nobody who could
    // act on it inside the request: the caller decides this response's cache TTL,
    // and a silent fallback got the full-success hour.
    //
    // ⚠️ This catch is DELIBERATELY broader than the repo's other fail-soft reads
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
    return { entries: pool.slice(0, cap), insightFallback: true };
  }
  return {
    entries: applyInsightRanking(pool, insights, criteria).slice(0, cap),
    insightFallback: false,
  };
}
