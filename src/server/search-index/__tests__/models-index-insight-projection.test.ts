import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';

/**
 * `insight.qualityScore` is the attribute the resource-intent pool is SEEDED by, and
 * `insight.role` / `insight.styleFamily` are the two MEANING axes — filterable, not
 * sortable, nothing reads them yet. This file pins the wiring that puts all three on a
 * document.
 *
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT PIN: the seed's sort array. Adding the axes to the
 * projection changed `searchShortlistModels` not at all — what the index WRITES and how the
 * seed ORDERS are separable, the attribute lists reach a live index only through a manual
 * full reset while the sort array is a plain code change — and that array is already pinned
 * whole by `toEqual(['insight.qualityScore:desc', 'metrics.thumbsUpCount:desc'])` in
 * ~/server/services/__tests__/resource-intent-matcher.service.test.ts. A second guard here
 * would fail in exactly the cases that one already fails in, so there isn't one.
 *
 * 🔴 These are WIRING guards, not behavioural ones, and the difference matters when
 * reading them as coverage. The projection RULE (max over labeled versions above the
 * promote floor, ties on the lowest version id, the winner's WHOLE row, `null` when none)
 * is tested behaviourally in
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

/**
 * The two MEANING axes. Filterable, deliberately NOT sortable, and projected from the SAME
 * version row as the score — the relationship this file's new guards exist to pin.
 */
const INSIGHT_AXIS_ATTRS = ['insight.role', 'insight.styleFamily'];

/**
 * The exact normalised text of the `insight` object literal `transformData` emits.
 *
 * 🔴 Pinned as a WHOLE STRING on purpose, against this file's own general preference for
 * pinning relationships over spellings — because here the hazard IS a spelling. A guard that
 * merely checks each key is present passes a literal whose `role` reads off a different
 * version than its `qualityScore`, which is the one defect in this projection that has no
 * downstream symptom (see ~/server/services/resource-insight.ts). Whitespace is collapsed
 * before comparing, so Prettier reflow cannot break it; the trailing comma is normalised away
 * for the same reason, since it is present only while Prettier keeps the literal multi-line.
 *
 * The intended cost of changing the projection is updating this string, and a reviewer then
 * reads what moved.
 */
const INSIGHT_LITERAL =
  'qualityScore: insightProjection?.qualityScore ?? null, ' +
  'role: insightProjection?.role ?? null, ' +
  'styleFamily: insightProjection?.styleFamily ?? null';

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
      /modelInsightProjection\( modelVersions\.map\(\(v\) => v\.id\), insights \)/
    );
  });

  it('🔴 takes all three axes from ONE projection call, so the winning row cannot be split', () => {
    // The defect with no downstream symptom: score from the best-scoring version, `role` from
    // some other one. The document validates, the index answers normally, and a purpose filter
    // then matches a model on a role no version of it that scored well actually has.
    //
    // Two halves, and both are needed. The literal pin says the three keys read the same
    // `insightProjection` binding with the same leaf names...
    const literal = flat.match(/insight: \{ (.*?) \},/)?.[1];
    expect(literal, 'the insight object literal was not found in transformData').toBeTruthy();
    expect((literal as string).replace(/,$/, '')).toBe(INSIGHT_LITERAL);

    // ...and the call count says that binding came from a SINGLE selection, so three separate
    // `modelInsightProjection(...)` calls — which could each pick a different winner if the
    // rule ever gains a non-deterministic branch — cannot satisfy the pin above by accident.
    // Counts call sites only: a mention of the name in prose carries no `(`.
    const calls = flat.match(/modelInsightProjection\(/g) ?? [];
    expect(calls, 'exactly one projection call per model').toHaveLength(1);
  });

  it('🔴 WRITES the null unconditionally — never omits a key, never coalesces to 0', () => {
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
    //
    // 🔴 All THREE keys, for the same reason: `role` and `styleFamily` are written on every
    // document too, so a retracted label cannot leave a stale role behind. A single
    // projection returning `null` has to become three written nulls, which is why the
    // literal spells each key out rather than spreading an object that may be absent.
    for (const leaf of ['qualityScore', 'role', 'styleFamily']) {
      expect(flat, `${leaf} must be written as \`?? null\`, never \`?? 0\` or omitted`).toMatch(
        new RegExp(`${leaf}: insightProjection\\?\\.${leaf} \\?\\? null`)
      );
    }
    // The three shapes that omit or defaultify instead, none of which the loop above can see.
    expect(flat).not.toMatch(/insightProjection\?\.\w+ \?\? \d/);
    expect(flat).not.toMatch(/insight: insightProjection/);
    expect(flat).not.toMatch(/\.\.\.\(insightProjection/);
    expect(flat).not.toMatch(/insightProjection === null \?/);
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

  it('🔴 declares BOTH meaning axes filterable — the purpose half of the projection', () => {
    // `insight.qualityScore` answers "how good"; these answer "what FOR", which is the
    // question a purpose query asks. Writing them into the document buys nothing on its own —
    // Meilisearch will not filter on an attribute that is not declared — so the projection
    // and these two entries are one change, and a half of it is inert.
    for (const attr of INSIGHT_AXIS_ATTRS) {
      expect(modelsFilterableAttributes, `${attr} must be filterable`).toContain(attr);
    }
  });

  it('🔴 keeps the meaning axes OUT of sortableAttributes — they are unordered categories', () => {
    // ⚠️ AN INVARIANT GUARD, not regression coverage: it is GREEN on `origin/main` too, where
    // these attributes do not exist at all, so it never watched the bug it prevents. Counted
    // as such — it pins a decision for the next person rather than catching a defect that
    // shipped. The regression half of this change is the twelve service-level cases and the
    // four wiring cases that were red at `origin/main`.
    //
    // Not symmetry-for-its-own-sake: a declared-but-meaningless sortable attribute is a
    // SILENT trap. Meilisearch accepts `insight.role:desc` on any declared sortable attribute
    // and answers in alphabetical order, which reads as a ranking, so "completing the set"
    // here would ship a plausible-looking ordering over a 9-value category with no order.
    for (const attr of INSIGHT_AXIS_ATTRS) {
      expect(modelsSortableAttributes, `${attr} must NOT be sortable`).not.toContain(attr);
    }
    // And the score is still the ONLY insight attribute that is sortable, so a third axis
    // added later cannot slip into the sortable list unnoticed.
    expect(modelsSortableAttributes.filter((a) => a.startsWith('insight.'))).toEqual([
      INSIGHT_SORT_ATTR,
    ]);
  });

  it('🔴 keeps all three axes OFF displayedAttributes, ON the withheld ledger, and OFF the DB-direct path', async () => {
    // ⚠️ ALSO AN INVARIANT GUARD for the two new axes, and that is the POINT rather than a
    // weakness: it is green on `origin/main` because both withholding mechanisms key on the
    // top-level `insight`, so the axes were already covered before they existed. The guard
    // records that fact so nobody has to re-derive it — and it is the thing that goes red if
    // a future axis is promoted to its own top-level key, which is the case where the
    // ride-along stops holding.
    //
    // Stored-but-undisplayed. Sorting and filtering on an undisplayed field were both
    // verified working on v1.15.0, so displaying any of these would buy nothing and would
    // widen what a public search hit returns.
    //
    // 🔴 Both list halves, because the absence alone is not the contract. ../displayed-attributes.ts
    // keeps `MODELS_WITHHELD_ATTRIBUTES` as the deliberate record of every top-level key a
    // document carries that the displayed list withholds — and its own history is the argument
    // for asserting membership: that list "shipped missing `flags`", and a review round caught
    // it rather than a test. An unlisted withheld key reads as an oversight to the next person
    // auditing the privacy boundary, which is exactly what that file exists to prevent.
    //
    // 🔴 AND THE THIRD HALF, WHICH NEITHER LIST CAN SEE: a whitelist that names a TRANSPORT
    // protects only that transport. `displayedAttributes` governs the MEILISEARCH read path;
    // `getModelSearchIndexRecords` builds the same records straight from the DB and hands them
    // to a `publicProcedure` with no `.output()` schema — the path that whitelist cannot
    // reach, and a real leak of `sortMetrics` once shipped through it.
    //
    // Adding the two meaning axes needed no edit to EITHER mechanism, and that is the thing
    // worth pinning rather than assuming: both key on the TOP-LEVEL attribute — Meili's
    // whitelist lets nested children ride along with their parent, and `withheldStripped`
    // deletes the parent key outright — so a NESTED axis is covered by `insight` already being
    // withheld. An axis promoted to its own TOP-LEVEL key would NOT be, and this is what then
    // fails.
    const [{ modelsDisplayedAttributes, MODELS_WITHHELD_ATTRIBUTES }, { withheldStripped }] =
      await Promise.all([
        import('~/server/search-index/displayed-attributes'),
        import('~/server/search-index/models.search-index'),
      ]);

    for (const attr of [INSIGHT_SORT_ATTR, ...INSIGHT_AXIS_ATTRS]) {
      const [topLevel] = attr.split('.');
      expect(modelsDisplayedAttributes, `${attr} must not be displayed`).not.toContain(attr);
      expect(modelsDisplayedAttributes, `${topLevel} must not be displayed`).not.toContain(
        topLevel
      );
      expect(MODELS_WITHHELD_ATTRIBUTES, `${topLevel} must be on the withheld ledger`).toContain(
        topLevel
      );
    }

    // The DB-direct path, behaviourally, with the NESTED shape the projection actually emits —
    // a membership assertion on a ledger cannot show that the strip reaches inside. The values
    // are checked as well as the keys: a strip that replaced the object with `{}` would pass a
    // `toHaveProperty` check on the leaves while still shipping the parent.
    const stripped = withheldStripped({
      id: 1,
      insight: { qualityScore: 0.9, role: 'style', styleFamily: 'photoreal' },
    }) as Record<string, unknown>;
    expect(stripped).not.toHaveProperty('insight');
    for (const token of ['qualityScore', 'role', 'styleFamily', 'photoreal']) {
      expect(
        JSON.stringify(stripped),
        `${token} must not survive anywhere on the record`
      ).not.toContain(token);
    }
    // And it must not strip anything else — over-stripping blanks the search card.
    expect(stripped.id).toBe(1);
  });
});
