import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';

/**
 * `insight.qualityScore` is the attribute the resource-intent pool is SEEDED by, and this
 * file pins the wiring that puts it on a document.
 *
 * 🔴 These are WIRING guards, not behavioural ones, and the difference matters when
 * reading them as coverage. The projection RULE (max over labeled versions above the
 * promote floor, `null` when none) is tested behaviourally in
 * ~/server/services/__tests__/resource-insight.test.ts. What is pinned HERE is only that
 * `transformData` calls that rule and spells the key the way the sortable attribute
 * expects — and it is pinned TEXTUALLY, following the precedent and the reasoning in
 * ./models-index-pricing-signals.test.ts: `transformData` is module-private and its real
 * signature needs a Prisma payload, several caches and a live DB.
 *
 * A textual guard is walkable by rewording, so the one assertion that carries real weight
 * is the cross-file one at the bottom: it DERIVES the expected key path from
 * `modelsSortableAttributes` instead of restating it, so the two files cannot drift apart
 * silently. That drift is the dangerous failure here — Meilisearch accepts a sort on a
 * declared-but-absent attribute and answers in an arbitrary order rather than erroring
 * (measured on v1.15.0), so a renamed document key with a stale sortable entry produces a
 * silently wrong ordering, not a loud 400.
 */
const indexSource = fs.readFileSync(
  path.join(process.cwd(), 'src/server/search-index/models.search-index.ts'),
  'utf8'
);
// Collapse whitespace so these assertions survive reformatting by Prettier, which wraps
// the conditional spread across lines at the current line width.
const flat = indexSource.replace(/\s+/g, ' ');

const INSIGHT_SORT_ATTR = 'insight.qualityScore';

describe('models search index projects insight.qualityScore', () => {
  it('loads the labels from the batch-wide id list, not a per-model one', () => {
    // ⚠ Reads what it says and no more: this pins the ARGUMENT as `versionIds` — the batch-wide
    // list — rather than a per-model one. It does NOT count queries, so it cannot by itself
    // distinguish a per-document regression; an earlier version of this test claimed it could.
    // What makes the per-model shape fail is that `versionIds` is built once outside the
    // per-model builder, so naming it here is only reachable from the batched position.
    expect(flat).toMatch(/loadResourceInsights\(versionIds\)/);
  });

  it("collapses the model's OWN version ids through the shared projection rule", () => {
    // `modelVersions` is the per-model list inside the builder; `versionIds` is the
    // batch-wide one. Passing the batch-wide list here would give every model in the
    // read window the same score — the highest in the batch.
    expect(flat).toMatch(
      /modelInsightQualityScore\( modelVersions\.map\(\(v\) => v\.id\), insights \)/
    );
  });

  it('🔴 WRITES the null unconditionally — never omits the key, never coalesces to 0', () => {
    // Two distinct mutations, both of which look harmless and neither of which any other
    // test here can see.
    //
    // A `?? 0` would put every unlabeled model at a real score of 0 — participating in the
    // ordering as though it had been judged, and sorting above any negative value — instead
    // of landing in Meilisearch's trailing group.
    //
    // 🔴 A CONDITIONAL SPREAD that omits the key on null is the subtler one, and it is what
    // this originally shipped. Omitting reads as equivalent, because a missing sortable
    // attribute and an explicit null sort the same way (measured). But every live write is
    // `PUT /indexes/<uid>/documents`, which MERGES top-level fields — so on a document that
    // already carries a score, omitting leaves the stale value in place and a retracted
    // label keeps its top-of-pool seeding forever. Measured both arms on v1.15.0: the null
    // PUT cleared a stored 0.9; the control PUT with no key left a stored 0.1 intact.
    expect(flat).toMatch(/insight: \{ qualityScore: insightQualityScore \}/);
    expect(flat).not.toMatch(/insightQualityScore === null \?/);
    expect(flat).not.toMatch(/insightQualityScore \?\? \d/);
    expect(flat).not.toMatch(/qualityScore: insightQualityScore \?\?/);
  });

  it('🔴 fails soft on a label-read error rather than dropping the whole index batch', () => {
    // `ResourceInsight` is hand-applied per environment, so in any environment where that
    // has not happened this read throws on EVERY batch. Unguarded that does not merely lose
    // the score: the batch is scored `error`, dropped after its retries, and `setLastUpdate`
    // advances anyway — so published models leave the index permanently, every 15 minutes,
    // with only a console line. An optional ordering refinement must not be able to do that.
    //
    // Pinned on the RELATIONSHIP rather than the spelling: the call must sit inside a `try`,
    // and the recovery must be an empty Map (which falls through to the same cleared path an
    // unlabeled model takes) — not a rethrow and not a bare log.
    expect(flat).toMatch(/try \{ insights = await loadResourceInsights\(versionIds\);/);
    expect(flat).toMatch(/catch \(error\) \{ insights = new Map\(\);/);
  });

  it('🔴 spells the document key exactly as the sortable attribute addresses it', () => {
    // Derived, not restated: if `modelsSortableAttributes` is renamed, this test demands
    // the projection move with it. Both halves must agree or Meilisearch sorts on an
    // attribute no document carries and silently returns an arbitrary order.
    expect(modelsSortableAttributes).toContain(INSIGHT_SORT_ATTR);

    const [top, leaf, ...rest] = INSIGHT_SORT_ATTR.split('.');
    // Guards the assumption this test is built on, so a three-level path in future fails
    // here loudly instead of being half-checked.
    expect(rest).toHaveLength(0);
    expect(top).toBeTruthy();
    expect(leaf).toBeTruthy();

    // The nesting the sort path implies: a top-level `insight` object holding `qualityScore`.
    // Pins the NESTING, not the surrounding punctuation — an earlier version required a `{`
    // immediately before the key, which was only true while the projection was a conditional
    // spread and broke the moment that became an ordinary property.
    expect(flat).toMatch(new RegExp(`\\b${top}: \\{ ${leaf}:`));
  });

  it('declares the attribute filterable too, so the labeled tier is separable', () => {
    // 🔴 The arms are `IS NOT NULL` / `IS NULL`, NOT `EXISTS` / `NOT EXISTS` — a written null
    // counts as existing, so `EXISTS` matches every document. An earlier version of this
    // comment named the wrong pair and nothing here could go red, because the assertion below
    // is membership only. The authoritative block — what each predicate returns, the FIVE
    // causes of a written null with their measured magnitudes, how the predicates behave
    // PRE-reset, and the positive control any run of these arms must perform — is beside this
    // entry in ~/server/search-index/filterable-attributes.ts. Read it there; it is not
    // restated here.
    expect(modelsFilterableAttributes).toContain(INSIGHT_SORT_ATTR);
  });

  it('🔴 keeps the attribute OUT of displayedAttributes and ON the withheld ledger', async () => {
    // Stored-but-undisplayed. Sorting and filtering on an undisplayed field were both
    // verified working on v1.15.0, so displaying it would buy nothing and would widen what a
    // public search hit returns.
    //
    // 🔴 Both halves, because the absence alone is not the contract. ../displayed-attributes.ts
    // keeps `MODELS_WITHHELD_ATTRIBUTES` as the deliberate record of every top-level key a
    // document carries that the displayed list withholds — and its own history is the argument
    // for asserting membership: that list "shipped missing `flags`", and a review round caught
    // it rather than a test. An unlisted withheld key reads as an oversight to the next person
    // auditing the privacy boundary, which is exactly what that file exists to prevent.
    const { modelsDisplayedAttributes, MODELS_WITHHELD_ATTRIBUTES } = await import(
      '~/server/search-index/displayed-attributes'
    );
    const [topLevel] = INSIGHT_SORT_ATTR.split('.');
    expect(modelsDisplayedAttributes).not.toContain(INSIGHT_SORT_ATTR);
    expect(modelsDisplayedAttributes).not.toContain(topLevel);
    expect(MODELS_WITHHELD_ATTRIBUTES).toContain(topLevel);
  });
});
