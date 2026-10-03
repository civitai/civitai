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
  it('loads the labels batched over the whole read window, not per model', () => {
    // Per-model would be one query per document across a ~718k-document rebuild.
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

  it('🔴 OMITS the key when there is no qualifying label, rather than writing 0', () => {
    // The load-bearing line. A `?? 0` here would put every unlabeled model at a real
    // score of 0 — participating in the ordering as though it had been judged, and
    // sorting above any negative value — instead of landing in Meilisearch's trailing
    // group. Measured on v1.15.0: a document missing a sortable attribute is not dropped
    // and sorts last in BOTH directions, which is the property the omission buys.
    expect(flat).toMatch(
      /insightQualityScore === null \? \{\} : \{ insight: \{ qualityScore: insightQualityScore \} \}/
    );
    // And the mutation this is really guarding against, asserted directly: no coalesce to
    // a numeric default anywhere on this value.
    expect(flat).not.toMatch(/insightQualityScore \?\? \d/);
    expect(flat).not.toMatch(/qualityScore: insightQualityScore \?\?/);
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
    expect(flat).toMatch(new RegExp(`\\{ ${top}: \\{ ${leaf}:`));
  });

  it('declares the attribute filterable too, so the labeled tier is separable', () => {
    // `EXISTS` / `NOT EXISTS` on this field is how the gold-set study splits the labeled
    // ~1.1% from the rest. Verified working on v1.15.0 against an undisplayed field.
    expect(modelsFilterableAttributes).toContain(INSIGHT_SORT_ATTR);
  });

  it('🔴 keeps the attribute OUT of the displayed-attributes whitelist', async () => {
    // Deliberate: stored-but-undisplayed, the same shape as `sortMetrics`, which
    // ../displayed-attributes.ts documents as a privacy boundary. Sorting and filtering on
    // an undisplayed field both verified working on v1.15.0, so listing it here would buy
    // nothing and would widen what a search hit returns.
    const { modelsDisplayedAttributes } = await import(
      '~/server/search-index/displayed-attributes'
    );
    expect(modelsDisplayedAttributes).not.toContain(INSIGHT_SORT_ATTR);
    expect(modelsDisplayedAttributes).not.toContain('insight');
  });
});
