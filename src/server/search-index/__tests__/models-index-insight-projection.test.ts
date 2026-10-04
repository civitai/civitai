import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';

/**
 * `insight.qualityScore` is the attribute the resource-intent pool is SEEDED by,
 * `insight.role` / `insight.styleFamily` are the two MEANING axes — filterable, not
 * sortable, nothing reads them yet — and `insight.modelVersionId` is the id of the version
 * all three were taken from, projected but declared in NO attribute list, so no search path
 * can return it at all (argued at the projection site in ../models.search-index.ts; the four
 * absences are pinned below). This file pins the wiring that puts all four on a document.
 *
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT PIN: the seed's sort array. Adding the axes to the
 * projection changed `searchShortlistModels` not at all — what the index WRITES and how the
 * seed ORDERS are separable — and that array is already pinned whole by
 * `toEqual(['insight.qualityScore:desc', 'metrics.thumbsUpCount:desc'])` in
 * ~/server/services/__tests__/resource-intent-matcher.service.test.ts. A second guard here
 * would fail in exactly the cases that one already fails in, so there isn't one.
 *
 * ⚠️ An earlier version of this paragraph said "the attribute lists reach a live index only
 * through a manual full reset", which is FALSE for the filterable list and is a claim
 * ../filterable-attributes.ts explicitly retracts beside its own `insight` entry:
 * src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts applies THAT list to the
 * live index with no reset. Only `sortableAttributes` and `displayedAttributes` are
 * reset-only. The separability argument above does not need the false half, so it no longer
 * carries it.
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
const INDEX_REL = 'src/server/search-index/models.search-index.ts';
const indexSource = fs.readFileSync(path.join(process.cwd(), INDEX_REL), 'utf8');
// Collapse whitespace so these assertions survive reformatting by Prettier, which wraps
// the conditional spread across lines at the current line width.
const flat = indexSource.replace(/\s+/g, ' ');

/**
 * 🔴 ASK THE PARSER, NOT THE TEXT — and this is a MEASURED defect, not a style preference.
 *
 * `flat` above is the whole file's text with whitespace collapsed, **comments included**, and
 * a non-global `.match()` returns the FIRST hit wherever it comes from. A review round
 * demonstrated the consequence: the headline split defect (`role` read off a different version
 * than the winning score) was planted, a doc comment quoting the correct emitted literal was
 * added above it — exactly the comment style ../displayed-attributes.ts and
 * ~/server/__tests__/models-displayed-attributes.test.ts already use for this very literal —
 * and **every text assertion went green**. Controls confirmed it was the instrument and not
 * the fixture: the same defect with no quoting comment went red, and the real file passed.
 *
 * So the two assertions that carry the row-coherence contract read the AST instead, where a
 * comment is not a property assignment and cannot satisfy anything. Same lesson, same
 * mechanism and the same `typescript` devDependency as the `callsIn` walk in
 * ~/server/__tests__/models-displayed-attributes.test.ts — reused rather than re-derived.
 *
 * The surviving `flat` assertions are the pre-existing ones plus the per-leaf diagnostics; they
 * are fine as diagnostics BECAUSE the AST pins sit beside them, and that is the whole reason
 * they are allowed to stay textual.
 */
const indexAst = ts.createSourceFile(INDEX_REL, indexSource, ts.ScriptTarget.Latest, true);

/** Every `name: initializer` property assignment in the file, as source text. */
function propertyAssignments() {
  const out: { name: string; initializer: string; node: ts.Expression }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node)) {
      out.push({
        name: node.name.getText(indexAst),
        initializer: node.initializer.getText(indexAst),
        node: node.initializer,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(indexAst, visit);
  return out;
}

/**
 * The `searchableAttributes` whitelist `onIndexSetup` applies, read from the AST because it is
 * a function-local literal rather than an exported module constant like the other three lists.
 *
 * 🔴 Asserts it found EXACTLY ONE such array literal, so this cannot return an empty list and
 * make its caller's `not.toContain` / `toEqual([])` assertions vacuously true — the reassuring
 * zero and the probe wired to nothing are indistinguishable without this. A second declaration
 * appearing in this file would also mean the caller is grading the wrong one.
 */
function searchableAttributeLiteral(): string[] {
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'searchableAttributes' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found.push(
        node.initializer.elements.map((el) =>
          ts.isStringLiteral(el) ? el.text : el.getText(indexAst)
        )
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(indexAst, visit);
  expect(
    found.length,
    `exactly one \`searchableAttributes\` array literal must be readable in ${INDEX_REL} — 0 means this walk is wired to nothing and every assertion over it is vacuous`
  ).toBe(1);
  return found[0];
}

/** Every call expression in the file, as the source text of its callee and arguments. */
function callExpressions() {
  const out: { callee: string; args: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      out.push({
        callee: node.expression.getText(indexAst),
        args: node.arguments.map((a) => a.getText(indexAst).replace(/\s+/g, ' ')),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(indexAst, visit);
  return out;
}

/** The ONE `insight:` property the document builder emits, parsed. */
function insightProperty() {
  const hits = propertyAssignments().filter((p) => p.name === 'insight');
  return { hits, only: hits[0] };
}

const INSIGHT_SORT_ATTR = 'insight.qualityScore';

/**
 * The two MEANING axes. Filterable, deliberately NOT sortable, and projected from the SAME
 * version row as the score — the relationship this file's new guards exist to pin.
 */
const INSIGHT_AXIS_ATTRS = ['insight.role', 'insight.styleFamily'];

/**
 * The winning version's id: PROJECTED onto every document, and declared NOWHERE — not
 * sortable, not filterable, not displayed, and not searchable. So no search path can return it
 * and it is not even reachable as a per-document oracle; it records which version the index
 * decided for at reset time, which is not recoverable from Postgres later. The full argument,
 * and the two routes that would make it readable (neither approved), is at the projection site
 * in ../models.search-index.ts.
 *
 * 🔴 FOUR absences, not three, and the count was wrong here and at the projection site until
 * an audit round named the fourth. They are pinned below, across TWO cases rather than one —
 * the filterable, sortable and SEARCHABLE absences in `keeps the winning version id OFF …`,
 * the displayed absence in the withheld-ledger sweep, which reaches it by iterating this
 * constant alongside the other attributes. A further assertion, the write-only ledger in the
 * declared/projected pairing case, is what keeps the field PRESENT in the document while
 * absent from the lists. No count is given for "the assertions" because that is the kind of
 * restated figure this file has already had to correct twice; the cases are named instead.
 *
 * ⚠️ WHY `searchableAttributes` BELONGS IN THAT LIST, since it is the one an enumeration keeps
 * missing: unreachability is not established by the three absences alone. That list is an
 * explicit whitelist in `onIndexSetup`, and Meili's default is `["*"]` — measured on a local
 * engine, with the whitelist `q=42` returns 0 hits and with `["*"]` it returns 1. Widening it
 * would therefore make the id reachable as a MEMBERSHIP oracle ("which model's winning version
 * is 42"), though not as a value leak: the hit body still withholds `insight`, which is a
 * separate mechanism. Equally true of the three pre-existing leaves, so it is not new exposure
 * from projecting the id — the enumeration was simply incomplete.
 *
 * It is read from the index file's AST rather than imported, because unlike `modelsSortable…`,
 * `modelsDisplayed…` and `modelsFilterable…` it is a FUNCTION-LOCAL literal with no export, so
 * there is nothing to import. That is also why it is the easiest of the four to forget.
 *
 * If one of them is in your way, making this field readable is the decision you are taking —
 * it is not an obstacle to route around.
 */
const INSIGHT_WRITE_ONLY_ATTR = 'insight.modelVersionId';

/**
 * The exact `name: value` list of the `insight` object literal `transformData` emits, read
 * from the AST so punctuation and comments are out of scope.
 *
 * 🔴 Pinned as a WHOLE ORDERED LIST on purpose, against this file's general preference for
 * pinning relationships over spellings — because here the hazard IS a spelling. A guard that
 * merely checks each key is PRESENT passes a literal whose `role` reads off a different
 * version than its `qualityScore`, which is the one defect in this projection that has no
 * downstream symptom (see ~/server/services/resource-insight.ts).
 *
 * The intended cost of changing the projection is updating this list, and a reviewer then
 * reads what moved.
 */
const INSIGHT_PROPERTIES = [
  'qualityScore: insightProjection?.qualityScore ?? null',
  'role: insightProjection?.role ?? null',
  'styleFamily: insightProjection?.styleFamily ?? null',
  'modelVersionId: insightProjection?.modelVersionId ?? null',
];

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
    //
    // Read off the AST: there must be exactly ONE projection call, and its arguments must be
    // the per-model id list and the batch-wide map.
    const calls = callExpressions().filter((c) => c.callee === 'modelInsightProjection');
    expect(calls, 'exactly one projection call per model').toHaveLength(1);
    expect(calls[0].args).toEqual(['modelVersions.map((v) => v.id)', 'insights']);
  });

  it('🔴 takes all four values from ONE projection call, so the winning row cannot be split', () => {
    // The defect with no downstream symptom: score from the best-scoring version, `role` from
    // some other one. The document validates, the index answers normally, and a purpose filter
    // then matches a model on a role no version of it that scored well actually has.
    //
    // `modelVersionId` is in the same literal and therefore the same contract: an id sourced
    // from anywhere but `insightProjection` would name a version the axes do not describe,
    // which is worse than omitting it — a consumer post-stratifying on that id would be
    // partitioning by the wrong thing while every value looked well-formed.
    //
    // The whole emitted literal, pinned from the AST. Any key reading off anything other than
    // the single `insightProjection` binding changes this string.
    const { hits, only } = insightProperty();
    expect(hits, 'exactly one `insight:` property is emitted').toHaveLength(1);
    expect(
      ts.isObjectLiteralExpression(only.node),
      '`insight` must be a plain object literal'
    ).toBe(true);

    // Every member must be a `name: value` assignment — which rejects a spread
    // (`...(insightProjection ? {…} : {})`) structurally rather than by grepping for one — and
    // the full ordered list must match, so an added, removed or re-sourced key all fail here.
    const props = (only.node as ts.ObjectLiteralExpression).properties.map((p) => {
      expect(ts.isPropertyAssignment(p), 'no spreads or shorthand in the insight literal').toBe(
        true
      );
      const pa = p as ts.PropertyAssignment;
      return `${pa.name.getText(indexAst)}: ${pa.initializer
        .getText(indexAst)
        .replace(/\s+/g, ' ')}`;
    });
    expect(props).toEqual(INSIGHT_PROPERTIES);

    // 🔴 And the clause that actually closes the split: a realistic split does NOT add a second
    // projection call, it reads the batch map directly (`insights.get(someOtherId)?.role`). The
    // call-count guard is blind to that — measured, it stays at 1 — so this is what sees it.
    // `insights` is read in exactly TWO places in this file: the assignment from
    // `loadResourceInsights`, and the argument handed to the projection. Nothing else may touch
    // it, which is what makes "one row" a property of the file rather than of one line.
    const insightsReads = callExpressions().filter((c) => c.callee.startsWith('insights.'));
    expect(insightsReads, 'the label map must never be read directly in this file').toEqual([]);
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
    // 🔴 All FOUR keys, for the same reason: `role`, `styleFamily` and `modelVersionId` are
    // written on every document too, so a retracted label cannot leave a stale role — or a
    // stale winning id — behind. A single projection returning `null` has to become FOUR
    // written nulls, which is why the literal spells each key out rather than spreading an
    // object that may be absent. `modelVersionId` is the no-qualifying-version null for the
    // id: the projection has no separate null for it (the whole object is null), so this
    // `?? null` is the only place that null is produced, and this is where it is pinned.
    //
    // ⚠️ This is the per-leaf DIAGNOSTIC, not the contract — the ordered AST list above is
    // the contract, and it subsumes every assertion here. The value of this loop is the
    // failure MESSAGE: it names which leaf went wrong instead of printing a list diff. It is
    // allowed to stay textual only because the AST pin sits beside it.
    const members = insightProperty().only.initializer.replace(/\s+/g, ' ');
    for (const leaf of ['qualityScore', 'role', 'styleFamily', 'modelVersionId']) {
      expect(members, `${leaf} must be written as \`?? null\`, never \`?? 0\` or omitted`).toMatch(
        new RegExp(`${leaf}: insightProjection\\?\\.${leaf} \\?\\? null`)
      );
    }
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

  it('🔴 pairs every DECLARED insight attribute with a key the document actually carries', () => {
    // Membership alone cannot see the half-change, and the test above says so in its own
    // comment without checking it: a future `insight.contentType` added to either list with no
    // projection change — or added to the projection under a differently-spelled leaf — is
    // silently INERT. Meilisearch filters happily on an attribute no document carries, every
    // document reads `IS NULL`, and nothing returns a 400. The score has a derived check of
    // this shape already; the axes had none, and `INSIGHT_AXIS_ATTRS` above is a restated
    // literal, so this is the assertion that makes the pairing machine-checked.
    //
    // Both directions, deliberately — but they are no longer the SAME assertion, and the
    // asymmetry is the point rather than a loosening.
    //
    // 🔴 DECLARED ⊆ PROJECTED IS ABSOLUTE: an attribute declared filterable or sortable with
    // no matching document key is the inert half of a half-change, and there is no legitimate
    // reason to have one.
    //
    // 🔴 PROJECTED ⊆ DECLARED IS NOT, AND IT USED TO BE ASSERTED AS SET EQUALITY, WHICH THIS
    // CHANGE BROKE. `insight.modelVersionId` is projected on purpose and declared nowhere on
    // purpose (../models.search-index.ts argues it; the four absences are pinned below). The
    // old equality read that as "a field written to every document for nothing" — a reasonable
    // default that is simply wrong for a field whose value IS the write. So the undeclared
    // side is now an asserted LEDGER rather than a prohibition: exactly the keys named here may
    // be written-but-unreadable, and the assertion fails when that set GROWS *or* SHRINKS.
    // Growing means somebody added another unreadable field without arguing for it; shrinking
    // means somebody declared this one readable, which is the decision the projection site says
    // is not approved. Either way a human reads the diff — which set equality also achieved,
    // but only by blocking the legitimate case outright.
    const declared = [...modelsFilterableAttributes, ...modelsSortableAttributes]
      .filter((a) => a.startsWith('insight.'))
      .map((a) => a.slice('insight.'.length));
    const projected = (insightProperty().only.node as ts.ObjectLiteralExpression).properties.map(
      (p) => (p as ts.PropertyAssignment).name.getText(indexAst)
    );
    const writeOnlyLeaf = INSIGHT_WRITE_ONLY_ATTR.slice('insight.'.length);

    // Positive control: a zero on either side would make the comparisons vacuously true.
    expect(declared.length, 'no insight.* attribute is declared at all').toBeGreaterThan(0);
    expect(projected.length, 'the document emits no insight key at all').toBeGreaterThan(0);

    // Direction 1 — every declared attribute is carried by a document key.
    const declaredSet = [...new Set(declared)].sort();
    expect(
      declaredSet.filter((leaf) => !projected.includes(leaf)),
      'these insight.* attributes are declared but no document key carries them — inert'
    ).toEqual([]);

    // Direction 2 — the written-but-undeclared set is exactly the ledger, no more and no less.
    expect(
      projected.filter((leaf) => !declaredSet.includes(leaf)).sort(),
      `the write-only insight ledger must be exactly [${writeOnlyLeaf}] — a key added here is an unargued unreadable field, a key missing is a readability decision`
    ).toEqual([writeOnlyLeaf]);
  });

  it('🔴 keeps the winning version id OFF filterableAttributes, sortableAttributes and searchableAttributes', () => {
    // The approved payload is filterable `insight.role` + `insight.styleFamily`, and nothing
    // more. This pins the half of that decision a list-membership test can actually check.
    //
    // 🔴 FILTERABLE IS THE ONE THAT MATTERS, and it is not symmetry-for-its-own-sake.
    // ../displayed-attributes.ts records, measured on v1.15.0, that filtering works on an
    // attribute this index WITHHOLDS from a hit, and `src/components/Search/search.client.ts`
    // points the browser at this index with a key published in `src/env/client-schema.ts`. So a
    // filterable attribute is a per-document ORACLE for anyone holding that key, one equality
    // at a time — the existing class with `insight.qualityScore`, which is accepted there.
    // Declaring the winning id filterable would WIDEN that oracle to reveal which of a model's
    // versions scored highest, i.e. a signal about internal labels, and that was not approved.
    //
    // Sortable would additionally be meaningless: an ordering over primary keys is an ordering
    // by insertion age wearing the costume of a ranking.
    expect(
      modelsFilterableAttributes,
      `${INSIGHT_WRITE_ONLY_ATTR} must NOT be filterable — it would widen the per-document oracle to internal label outcomes`
    ).not.toContain(INSIGHT_WRITE_ONLY_ATTR);
    expect(
      modelsSortableAttributes,
      `${INSIGHT_WRITE_ONLY_ATTR} must NOT be sortable`
    ).not.toContain(INSIGHT_WRITE_ONLY_ATTR);

    // And the positive half, so this case cannot pass by the attribute lists being empty or by
    // `insight.*` having silently left them altogether.
    expect(modelsFilterableAttributes.filter((a) => a.startsWith('insight.')).sort()).toEqual(
      [...INSIGHT_AXIS_ATTRS, INSIGHT_SORT_ATTR].sort()
    );

    // 🔴 THE FOURTH LIST — see the `INSIGHT_WRITE_ONLY_ATTR` docstring for why closure depends
    // on it and why an enumeration keeps missing it. Searchable is the only one of the four
    // whose absence is not enough on its own: the list must stay an explicit WHITELIST, because
    // Meili's `["*"]` default would re-admit every leaf by free-text query.
    const searchable = searchableAttributeLiteral();
    // Positive control for the walk, on a value the whitelist has carried since long before
    // `insight` existed — a walk that read an array it could not resolve would fail here.
    expect(searchable, 'the searchableAttributes walk did not read the real list').toContain(
      'name'
    );
    expect(
      searchable,
      'searchableAttributes must stay an explicit whitelist — Meili’s `["*"]` default would make every insight leaf reachable by free-text query'
    ).not.toContain('*');
    expect(
      searchable.filter((a) => a.startsWith('insight')),
      'no insight.* attribute may be searchable — a searchable leaf is a per-document MEMBERSHIP oracle (a q= query that matches reveals which model carries the value) even though the hit body still withholds `insight`'
    ).toEqual([]);
  });

  it('🔴 keeps the meaning axes OUT of sortableAttributes — they are unordered categories', () => {
    // ⚠️ AN INVARIANT GUARD, not regression coverage: it is GREEN on `origin/main` too, where
    // these attributes do not exist at all, so it never watched the bug it prevents. Counted
    // as such — it pins a decision for the next person rather than catching a defect that
    // shipped.
    //
    // 🔴 And the honest account of what WAS red at `origin/main`. RE-DERIVED at this commit by
    // running this file over `origin/main`'s four non-test sources with `--reporter=verbose`,
    // and both figures below MOVED when they were re-derived:
    //
    //   - **SIX** of this file's 12 cases failed there, every one by its OWN assertion and none
    //     by a thrown error: the projection call (`expected [] to have a length of 1`), the
    //     ordered literal, the `?? null` diagnostic, the filterable membership of the two axes,
    //     the declared/projected pairing, and the write-only-id absence case. ⚠️ This said
    //     "Four cases" and listed the first four — correct when written, and invalidated by the
    //     same commit that corrected the other number here: the pairing case was GREEN at base
    //     until its undeclared-side assertion became a ledger, and the id-absence case is new.
    //     That is this comment's own stated lesson biting a third time.
    //   - **ELEVEN** of the 13 `modelInsightProjection` cases in
    //     ~/server/services/__tests__/resource-insight.test.ts went red, on
    //     `TypeError: modelInsightProjection is not a function`. ⚠️ This said "twelve", which
    //     was wrong twice over: the describe holds 13 cases, and 2 of them are GREEN at base
    //     because they do not call the new symbol. The authoritative breakdown is in that
    //     file's own describe docstring; it is not restated here beyond the count.
    //
    // A missing-symbol red is evidence the function is NEW, not evidence the behaviour
    // regressed. Those cases' teeth come from the mutation battery run at HEAD, not from that
    // red.
    //
    // Not symmetry-for-its-own-sake: a declared-but-meaningless sortable attribute is a
    // SILENT trap. Meilisearch accepts `insight.role:desc` on any declared sortable attribute
    // and answers in alphabetical order, which reads as a ranking, so "completing the set"
    // here would ship a plausible-looking ordering over `RESOURCE_INTENT_ROLE_OPTIONS`
    // (~/server/schema/resource-intent.schema.ts), which has no order at all.
    for (const attr of INSIGHT_AXIS_ATTRS) {
      expect(modelsSortableAttributes, `${attr} must NOT be sortable`).not.toContain(attr);
    }
    // And the score is still the ONLY insight attribute that is sortable, so a third axis
    // added later cannot slip into the sortable list unnoticed.
    expect(modelsSortableAttributes.filter((a) => a.startsWith('insight.'))).toEqual([
      INSIGHT_SORT_ATTR,
    ]);
  });

  it('🔴 keeps all four insight keys OFF displayedAttributes, ON the withheld ledger, and OFF the DB-direct path', async () => {
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

    // 🔴 `INSIGHT_WRITE_ONLY_ATTR` is swept here too, and for it this is not a ride-along note
    // but THE assertion that makes "no search path can return it" machine-checked. Being
    // undisplayed is what makes it unreadable: `attributesToRetrieve` can only narrow WITHIN
    // the displayed set, so it cannot re-admit a withheld attribute, and the id is declared in
    // neither the filterable nor the sortable list either (pinned above). Remove `insight` from
    // the withheld ledger and this case goes red — which is the intended cost of the DISPLAY
    // route named at the projection site.
    for (const attr of [INSIGHT_SORT_ATTR, ...INSIGHT_AXIS_ATTRS, INSIGHT_WRITE_ONLY_ATTR]) {
      const [topLevel] = attr.split('.');
      expect(modelsDisplayedAttributes, `${attr} must not be displayed`).not.toContain(attr);
      expect(modelsDisplayedAttributes, `${topLevel} must not be displayed`).not.toContain(
        topLevel
      );
      expect(MODELS_WITHHELD_ATTRIBUTES, `${topLevel} must be on the withheld ledger`).toContain(
        topLevel
      );
    }

    // The DB-direct path, behaviourally, with the NESTED shape the projection actually emits.
    // ONE assertion, and the reasoning for why it is one is worth keeping: the strip does not
    // reach INSIDE `insight`, it deletes the parent — so a per-leaf loop under this line cannot
    // fail unless this line already failed, and an earlier version of this block carried four
    // such assertions justified by a mutant (`out[attr] = {}`) that this line kills on its own.
    expect(
      withheldStripped({
        id: 1,
        insight: {
          qualityScore: 0.9,
          role: 'style',
          styleFamily: 'photorealistic',
          modelVersionId: 42,
        },
      })
    ).toEqual({ id: 1 });
  });
});
