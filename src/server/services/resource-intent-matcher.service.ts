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

/**
 * Pool width as a multiple of the response cap, so a candidate the popularity
 * seed placed outside the response can still be promoted into it.
 *
 * 🔴 The effective width is `min(cap * 2, RESOURCE_INTENT_MAX_SHORTLIST)`, which
 * starts shrinking at `cap = 128` and reaches 1x — i.e. reorder-the-visible-page
 * only — at the maximum accepted `limit` of 255. That is deliberate (the pool is
 * the work bound as well as the lookahead) but it means the widening is a
 * property of the DEFAULT cap of 50, not of every request.
 *
 * `clampResourceIntentCap` is therefore the ONE bound on both the pool and the
 * search page below — raising `RESOURCE_INTENT_MAX_SHORTLIST` to widen responses
 * also raises this re-rank's work bound. A second ceiling here was deleted for
 * being unreachable while that constant stays under it; if it is ever raised past
 * Meilisearch's own `maxTotalHits`, the page silently truncates and the ceiling has
 * to come back.
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
 * The floor for PROMOTION. `ResourceInsight.confidence` is the WEAKEST of a row's
 * four label judgments — including the `contentType` one this ordering never reads
 * — and the written distribution is p50 0.43 / mean 0.44 with only 3.4% of rows at
 * or above 0.70. So a 0.70 floor would discard ~96.6% of the labels and leave this
 * ordering inert; 0.30 is the measured ~12.8th percentile.
 *
 * ⚠️ Read that argument for what it weighs: the cost of a HIGH floor on this side
 * is a label that never gets to help, i.e. the feature doing nothing. It says
 * nothing about the demote side, which is why that side has its own constant below.
 */
export const RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE = 0.3;

/**
 * The floor for DEMOTION — a separate constant because the two directions have
 * ASYMMETRIC error costs and only the promote side has ever been argued.
 *
 * 🔴 This value is INHERITED from the promote-side argument above, not derived for
 * demotion. It is set equal to it so today's behaviour is unchanged; the split
 * exists so the demote floor can be moved in a validation window without touching
 * the promote floor, which until now it could not be.
 *
 * The asymmetry, stated so the next person does not have to re-derive it. Raising
 * THIS floor costs a missed demotion, and a row that fails to demote simply sits
 * neutral — seed order, which is the pre-feature behaviour. Raising the promote
 * floor costs the ordering its reason to exist. And the demote side's mistakes are
 * not merely reorderings: the permutation is sliced to the response cap, so a
 * demotion on a pool wider than the cap evicts a candidate from the returned page.
 *
 * Measured on a realistic approximation of a pool (not through this function): in
 * the worst cell sampled the demote bucket held 49 of 100 candidates, with median
 * confidence 0.45 and NONE at or above 0.70. So at this floor the bucket is a large
 * minority of a pool rather than a rare correction, and it is not selected by high
 * confidence — which is why neither this file nor the contract doc calls it the
 * "confident" bucket any more.
 *
 * Deliberately NOT raised here: where to put it is a product judgment about how
 * much eviction an unvalidated label is allowed to cause, and that judgment has not
 * been made.
 */
export const RESOURCE_INSIGHT_MIN_DEMOTE_CONFIDENCE = 0.3;

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
 * handed to this function is seeded by a popularity sort, and the labeled set IS
 * the catalogue's high-usage head — the lowest `generationCount` among labeled
 * versions is 46,798 — so coverage INSIDE a pool runs ~30-45x the corpus rate:
 * 33.3% of the versions of the top 100 models by thumbs-up (350 of 1,050), and ~45%
 * restricted to the LoRA family (236 of 522). Measured against the primary Postgres
 * database, three times independently.
 *
 * So bucketing is not held up here by labels being rare, and this comment does not
 * substitute a fresh argument for it. What survives the retraction is a property,
 * not a justification: a labeled and an unlabeled candidate share no scale, so any
 * scoring scheme has to invent a score for the unlabeled majority, and the neutral
 * band is how this ordering avoids inventing one — which is what the paragraph
 * above describes. Whether buckets or scores serve better at the in-pool coverage
 * measured above has never been tested, and it is the first thing to revisit once
 * the shadow table can grade the ordering (see the closing condition in
 * `docs/resource-intent-primitive.md`).
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
    // 🔴 ONE DOCUMENT PER TARGETED VERSION — the POOL width, not the response cap,
    // and no multiplier on top. A model USUALLY contributes at least one matching
    // version, but not always: the indexed coverage and baseModel filters are both
    // nested-array matches, so one document can match on two DIFFERENT versions and
    // expand to zero (measured at 20 of the 49,000 documents the sweep below
    // returned, 0.04%). What carries this width is that measurement, not the
    // invariant.
    //
    // The sweep: over 98 populated role x baseModel x browsing-level cells, this
    // width filled the pool in EVERY cell at each of the caps measured — 1, 5, 50
    // and the maximum 255 — consuming 10-48 documents at the default cap of 50 and
    // 173 in the worst cell at 255. ⚠️ It queried the live index but re-implemented
    // THIS filter and expansion rather than calling them, so it is evidence about
    // the index's shape, not a test of this function; re-measure through the service
    // before trusting it against a change to `expandShortlist`. Caps in between are not individually swept; 255
    // is the hardest point, since the multi-version head is consumed first and the
    // margin narrows with depth (2.1x at cap 50 against 1.47x at 255).
    //
    // Separately, and by ARITHMETIC rather than measurement — no data needed, just
    // the two expressions: this page is identical to the one BEFORE this feature for
    // caps 1-127, strictly narrower for 128-255, and never wider. Stated against
    // that baseline specifically, because this branch held three page widths in turn
    // and the claim is only exact against the first.
    //
    // And back to MEASUREMENT for what the removed 2x cost: it added zero pool
    // members in any cell, and cost 1.6-2.6x the payload and its blocking
    // JSON.parse plus roughly double the index's own processing time, on a
    // Meilisearch shared with the resource picker. At the maximum cap this form is
    // also ~1.8x cheaper than the 500-document page the old arithmetic asked for
    // there — a 1.96x document reduction, so that saving is measured too, not a
    // ratio of the two expressions.
    limit: poolCap,
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

/**
 * What `findResourceIntentCandidates` returns, as a RESULT OBJECT rather than a
 * bare array, so the fail-soft path below cannot be silent.
 *
 * 🔴 `insightFallback` exists because the fallback is otherwise indistinguishable
 * from success at the seam: the caller receives a well-formed, correctly-capped
 * shortlist in popularity order and has no way to learn that the labels were never
 * read. That cost the caller its cache TTL decision — a label-read failure is as
 * transient as the vendor failures the service caches for 60s, and without this
 * flag its unordered response was pinned for the full hour instead.
 */
export type ResourceIntentShortlist = {
  entries: ResourceIntentShortlistEntry[];
  /**
   * `true` ⇒ the `ResourceInsight` read FAILED on this call and `entries` is the
   * popularity seed order, unordered by any label.
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
): Promise<ResourceIntentShortlist> {
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
    // unreachable label table costs the ordering refinement and nothing else —
    // but it is REPORTED, not swallowed. The log alone reached nobody who could
    // act on it inside the request: the caller decides this response's cache TTL,
    // and a silent fallback got the full-success hour.
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
