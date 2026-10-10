import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { modelsSearchableAttributes } from '~/server/search-index/searchable-attributes';
import { modelsSortableAttributes } from '~/server/search-index/sortable-attributes';

import type * as MeiliClientModule from '~/server/meilisearch/client';
import type * as MeiliUtilModule from '~/server/meilisearch/util';
import type * as BaseSearchIndexModule from '~/server/search-index/base.search-index';

/**
 * 🔴 THE BEHAVIOURAL SEAM. Everything else in this file is a SYNTACTIC claim about
 * ../models.search-index.ts, and a syntactic claim cannot say what the engine was handed.
 *
 * Measured premise for why that gap existed and had to be closed here rather than assumed away:
 * across the 2,969 tracked test files AS THEY STOOD BEFORE THIS CASE WAS ADDED, nothing called
 * `.reset(` or `.setup(` on any search-index processor, and every `modelsSearchIndex` reference was
 * a `vi.mock` stub. So "the engine receives the frozen list" was proven STRUCTURALLY and never once
 * BEHAVIOURALLY.
 *
 * ⚠️ THAT PREMISE IS PAST-TENSE ON PURPOSE, AND IT USED TO BE WRITTEN "at this head" — WHICH THIS
 * VERY FILE FALSIFIES. The `describe` below calls `processor.setup(...)`, and a second block does a
 * real `await import(...)` of the module rather than a stub, so the present-tense form was refuted
 * by the commit that wrote it: a reader could cite it to argue this seam is unnecessary and delete
 * the case. A premise stated as an ABSENCE must name the corpus AND the moment it was swept.
 * The `57` reference count that stood here is DELETED rather than corrected — a later round could
 * not reproduce it at any ref under any scoping (55 at the merge-base, 55 before this commit, 61
 * here), so no stated corpus makes it true and it was never load-bearing.
 *
 * 🔴 AND THE ROUTE IN, BECAUSE THE OBVIOUS ONE DOES NOT EXIST AND READS AS IF IT DOES.
 * `onIndexSetup` is module-private, and `modelsSearchIndex.setup` is NOT a thing:
 * `createSearchIndexUpdateProcessor` DESTRUCTURES `setup` out of its argument
 * (../base.search-index.ts, `const { indexName, setup, prepareBatches, … } = processor`) and the
 * object it RETURNS carries only `indexName`, `updateSyncChunkSize`, `getHandledIds`,
 * `prepareBatches`, `getData`, `update`, `reset`, `updateSync`, `queueUpdate` and `processQueues`.
 * Reading the destructuring as part of the return is an easy mistake — they are 26 lines apart —
 * and it matters because the conclusion flips: `modelsSearchIndex.setup({ … })` is `undefined`.
 *
 * The only production path to `setup` is `reset()` (../base.search-index.ts, `await setup({
 * indexName: swapIndexName })`), which then pulls batches off a live DB — not reachable from a
 * unit test. So this suite reaches the function the one way that needs NO production export:
 * `createSearchIndexUpdateProcessor` is replaced with identity, which makes the module's
 * `modelsSearchIndex` the processor OBJECT LITERAL it already writes — and that literal carries
 * `setup: onIndexSetup` (../models.search-index.ts). The function under test is the real one;
 * only the wrapper around it is stubbed. Exporting `onIndexSetup` from production to make a test
 * possible was the alternative and was rejected.
 *
 * Each factory spreads `importOriginal()` and overrides exactly one export, per
 * `local-rules/no-wholesale-module-mock`: a hand-written replacement object pins the module's
 * export surface to the day it was written, and the next export added to it resolves to
 * `undefined`, taking the whole file out at COLLECTION — `Tests no tests`, nothing red.
 */
const setupProbe = vi.hoisted(() => {
  const received: { method: string; arg: unknown }[] = [];
  const record = (method: string) => async (arg: unknown) => {
    received.push({ method, arg });
    return { taskUid: 0 };
  };
  return {
    received,
    // `getSettings` returning `{}` makes every `JSON.stringify(list) !== JSON.stringify(settings.x)`
    // guard in `onIndexSetup` true, so every write fires. A fixture that happened to MATCH the
    // current settings would skip the writes and leave this case vacuously green.
    index: {
      getSettings: async () => ({}),
      updateSearchableAttributes: record('updateSearchableAttributes'),
      updateSortableAttributes: record('updateSortableAttributes'),
      updateDisplayedAttributes: record('updateDisplayedAttributes'),
      updateRankingRules: record('updateRankingRules'),
      updateFilterableAttributes: record('updateFilterableAttributes'),
      updateTypoTolerance: record('updateTypoTolerance'),
    },
  };
});

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClientModule>()),
  // `onIndexSetup` opens with `if (!client) return;`, and the real `searchClient` is `null`
  // unless SEARCH_HOST and SEARCH_API_KEY are both set — which they are not in this
  // environment. Without this override the function returns before touching anything and the
  // case below passes having measured nothing.
  searchClient: {} as unknown as typeof MeiliClientModule.searchClient,
}));

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtilModule>()),
  getOrCreateIndex: async () => setupProbe.index,
}));

vi.mock('~/server/search-index/base.search-index', async (importOriginal) => ({
  ...(await importOriginal<typeof BaseSearchIndexModule>()),
  createSearchIndexUpdateProcessor: (processor: unknown) => processor,
}));

/**
 * `insight.role` / `insight.styleFamily` are the two MEANING axes — filterable, not
 * sortable; no runtime query filters or sorts on any `insight.*` field (the resource-intent
 * seed is popularity alone). `insight.modelVersionId` is the id of the version all three were taken from, projected but
 * declared in NO attribute list, so no search path can return it at all (argued at the
 * projection site in ../models.search-index.ts; the four absences are pinned below). This
 * file pins the wiring that puts all four on a document.
 *
 * ⚠️ WHAT THIS FILE DELIBERATELY DOES NOT PIN: the seed's query. What the index WRITES and
 * how the seed QUERIES are separable, and the seed page (filter, sort and limit) is already
 * pinned in ~/server/services/__tests__/resource-intent-matcher.seed.test.ts, which also
 * runs the matcher against an in-memory index that honours it. A second guard here
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
 * Declarations of `const <name> = …` anywhere in the index file, by name — the same helper the
 * displayed-list guard uses (`declaredNames` in ~/server/__tests__/models-displayed-attributes.test.ts),
 * reused rather than re-derived.
 *
 * 🔴 FILE-WIDE on purpose, and that is the whole point of the shape. The guard it serves bans a
 * LOCAL BINDING of the hoisted list's name existing at all, so there is nothing to mutate between
 * a declaration and the write. Scoping the ban to one function is what let a measured mutant
 * escape: a helper taking the array as a PARAMETER and pushing onto it kept every
 * `onIndexSetup`-scoped count clean while the engine received `['name', 'user.username',
 * 'hashes', 'triggerWords', '*', 'insight.modelVersionId']`.
 *
 * 🔴 It asserts it found something, because a walk that resolved nothing would make every
 * `not.toContain` over it vacuously true — the reassuring zero and the probe wired to nothing are
 * indistinguishable without this.
 */
function declaredNames(): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(indexAst, visit);
  expect(
    names.length,
    `declarations must be readable in ${INDEX_REL} — 0 means this walk is wired to nothing and every \`not.toContain\` over it is vacuous`
  ).toBeGreaterThan(0);
  return names;
}

/**
 * Every call expression in the file: the source text of its callee and arguments, plus the
 * callee's method name resolved STRUCTURALLY as `method`.
 *
 * 🔴 `method` is NOT `callee.split('.').pop()`, and the difference is measured rather than
 * hypothetical. That idiom is the one TEXTUAL matcher in a pair whose comments advertise it as
 * structural: a second write spelled `index.updateSearchableAttributes([…])` is caught (the
 * write-count assertion fails, "to have a length of 1 but got 2"), but the SAME write spelled
 * `index['updateSearchableAttributes']([…])` left the whole suite green — `.split('.').pop()` returns the entire
 * `index['updateSearchableAttributes']` text and matches nothing.
 *
 * An element-access callee with a string-literal argument resolves to the same method as a
 * property access, so resolving it here is what makes the matcher mean what its comments claim.
 * `isStringLiteralLike` also covers the backtick form (``index[`update…`]``), which is the same
 * call again. A computed key that is not a literal (`index[k]`) stays unresolved and is therefore
 * NOT matched — stated plainly because that IS the remaining gap, and it cannot be closed by a
 * syntactic walk: naming the method would need the value of `k`.
 */
function callExpressions() {
  const methodOf = (expr: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isElementAccessExpression(expr)) {
      const arg = expr.argumentExpression;
      return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
    }
    return undefined;
  };
  const out: { callee: string; method?: string; args: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      out.push({
        callee: node.expression.getText(indexAst),
        method: methodOf(node.expression),
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
 * an audit round named the fourth. They are pinned below, across SEVERAL cases rather than one —
 * the filterable, sortable and SEARCHABLE absences in `keeps the winning version id OFF …`, the
 * displayed absence in the withheld-ledger sweep, which reaches it by iterating this constant
 * alongside the other attributes. A further assertion, the write-only ledger in the
 * declared/projected pairing case, is what keeps the field PRESENT in the document while absent
 * from the lists. ⚠️ And the searchable absence takes a SECOND case, `applies that whitelist
 * VERBATIM …`, because the membership case reads the LIST and the engine is given whatever the
 * write ARGUMENT evaluates to: three mutants escaped a fully green suite on that gap — a push
 * onto the local, a spread at the call site, and a module-scope helper taking the array as a
 * parameter. That third one is why the list no longer lives inside `onIndexSetup`; the history is
 * in that case. No count is given for "the assertions" because that is the kind of restated
 * figure this file has already had to correct twice; the cases are named instead — and "TWO
 * cases" is exactly such a figure, which is why it is no longer one.
 *
 * ⚠️ WHY `searchableAttributes` BELONGS IN THAT LIST, since it is the one an enumeration keeps
 * missing: unreachability is not established by the three absences alone. That list is an
 * explicit whitelist applied by `onIndexSetup`, and Meili's default is `["*"]` — measured on a
 * local engine, with the whitelist `q=42` returns 0 hits and with `["*"]` it returns 1. Widening
 * it would therefore make the id reachable as a MEMBERSHIP oracle ("which model's winning version
 * is 42"), though not as a value leak: the hit body still withholds `insight`, which is a
 * separate mechanism. Equally true of the three pre-existing leaves, so it is not new exposure
 * from projecting the id — the enumeration was simply incomplete.
 *
 * ⚠️ IT USED TO BE THE EASIEST OF THE FOUR TO FORGET, FOR A STRUCTURAL REASON THAT IS NOW FIXED:
 * it was a function-local literal with no export, so unlike `modelsSortable…`,
 * `modelsDisplayed…` and `modelsFilterable…` there was nothing to import and this file read it
 * out of the index's AST. It now lives in ../searchable-attributes.ts and is imported like the
 * other three. That asymmetry was not only a readability problem — it is what made a mutation
 * guard on it escapable, which is recorded in the `applies that whitelist VERBATIM …` case.
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
    // label stays visible to any filter or sort on it forever. Measured both arms on v1.15.0: the null
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
    // the score: every batch is scored `error` and fails after its retries, so published
    // models stay out of the index for as long as the read keeps throwing, with only console
    // lines. An optional ordering refinement must not be able to do that.
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
    // Read by IMPORT, like the other three lists. It used to be read out of the index file's AST,
    // because it was a function-local literal with nothing to import; hoisting it to
    // ../searchable-attributes.ts removed that asymmetry and the walk with it.
    //
    // Positive control, on a value the whitelist has carried since long before `insight` existed:
    // an import resolving to the wrong thing, or to an empty list, would fail here rather than
    // making the two absences below vacuously true.
    expect(
      modelsSearchableAttributes,
      'the searchable whitelist did not resolve to the real list'
    ).toContain('name');
    expect(
      modelsSearchableAttributes,
      'searchableAttributes must stay an explicit whitelist — Meili’s `["*"]` default would make every insight leaf reachable by free-text query'
    ).not.toContain('*');
    expect(
      modelsSearchableAttributes.filter((a) => a.startsWith('insight')),
      'no insight.* attribute may be searchable — a searchable leaf is a per-document MEMBERSHIP oracle (a q= query that matches reveals which model carries the value) even though the hit body still withholds `insight`'
    ).toEqual([]);
  });

  it('🔴 applies that whitelist VERBATIM — pins the write ARGUMENT and bans any local binding of it', () => {
    // 🔴 THE CASE ABOVE PINS THE DECLARATION. THIS ONE PINS WHAT REACHES THE ENGINE, and the
    // two are different claims — which is a measured defect in this repo, not a theoretical
    // gap. The displayed-list guard shipped the identical hole and records it in its own
    // comment (~/server/__tests__/models-displayed-attributes.test.ts, "passes the shared
    // module STRAIGHT to the processor write"): a `displayedAttributes.push('sortMetrics')` on
    // the line after a structurally-pinned initialiser re-opened the leak and passed the
    // entire suite.
    //
    // 🔴 THIS GUARD IS THE DISPLAYED LIST'S SHAPE, NOT A BESPOKE ONE, AND IT GOT HERE THE HARD
    // WAY — THREE HOLES, THE THIRD OF WHICH IS WHY THE PRODUCTION CODE MOVED. Each escape left
    // a fully green suite, so none was found by reading:
    //   - a `.push` on the line after the declaration (pinning the declaration is not pinning
    //     the write);
    //   - `index.updateSearchableAttributes([...searchableAttributes, '*', …])` at the call site
    //     (a declaration-scoped guard never sees the argument);
    //   - and then, against a guard that had closed both of those with a function-scoped
    //     member-access ban plus a reference ledger: a module-scope HELPER taking the array as a
    //     parameter and pushing onto it —
    //       `const applyWhitelist = async (index, searchableAttributes) => {
    //          searchableAttributes.push('*', 'insight.modelVersionId');
    //          await index.updateSearchableAttributes(searchableAttributes); };`
    //     Re-measured at this head before the hoist: whole suite green,
    //     `pnpm typecheck` 0 errors, while the engine received
    //     `['name','user.username','hashes','triggerWords','*','insight.modelVersionId']`.
    //     Inside `onIndexSetup` the ledger still read 1 declaration + 2 reads and `memberTargets`
    //     was still `[]`; the mutation had simply moved out of the scope being walked. The
    //     ARGUMENT pin was file-wide and saw a bare identifier, so it passed too.
    //
    // 🔴 WHY THE THIRD HOLE WAS FIXED IN PRODUCTION RATHER THAN PATCHED HERE. The bespoke pair
    // existed only because this list was a function-local `const` while the other three were
    // exported module constants — and that asymmetry WAS the seam. A guard that must distinguish
    // "legitimate use of a local" from "mutation of a local" has to pick a scope to walk, and
    // whichever it picks there is an adjacent scope the mutation can move to. So the list was
    // hoisted into ../searchable-attributes.ts, the local was deleted, and the remedy the
    // displayed list already proved applies verbatim: with NO local binding there is nothing to
    // mutate between a declaration and the write, which closes the helper route by construction
    // instead of detecting one shape of it.
    //
    // ⚠️ "THE REMEDY … APPLIES VERBATIM" WAS AN OVERSTATEMENT WHEN WRITTEN, AND THE GAP WAS LIVE.
    // The displayed list's shape is THREE guards, not one remedy and not two: a tree-wide WRITER
    // LEDGER, this argument pin, and the no-local ban. Only the latter two were copied here, and
    // both walk `models.search-index.ts` alone — so the one tree-wide member was missing and a
    // writer in a SECOND FILE was invisible to the whole set. Measured: a new
    // `src/pages/api/admin/temp/apply-models-index-searchable-attributes.ts` doing
    // `index.updateSearchableAttributes(['*'])` left this suite fully green and
    // typecheck at 0 errors while the live index would take `["*"]`. The third guard now exists —
    // `has exactly nine writers of searchableAttributes, tree-wide` in
    // ~/server/__tests__/models-displayed-attributes.test.ts, beside the displayed list's own
    // ledger and the tree-wide mutation ledger, which is where the tree-wide walks live.
    const calls = callExpressions().filter((c) => c.method === 'updateSearchableAttributes');

    // Pin the ARGUMENT, which is what decides what THIS writer hands the engine.
    // Exactly one write, and its argument is the BARE module name — not a spread, not an inline
    // array, not a concatenation, not a helper call.
    //
    // ⚠️ THIS SAID "the only thing that decides what the live index ends up with", AND THAT IS
    // FALSE in exactly the direction that matters: the walk is scoped to this ONE file, so it says
    // nothing about any other writer of the setting. What the live index ends up with is decided by
    // the argument of EVERY `updateSearchableAttributes` call in the tree — which is the claim the
    // writer ledger makes, not this one. Neither is sufficient alone, and reading this as
    // sufficient is what left the second-file route open.
    expect(calls, 'exactly one updateSearchableAttributes write must exist').toHaveLength(1);
    expect(
      calls[0].args,
      'the searchableAttributes write must pass the shared module export straight through — a spread, an inline array or a helper call at the call site re-admits anything it likes while the list itself still reads clean'
    ).toEqual(['modelsSearchableAttributes']);

    // And no local binding to shadow it. BOTH names, and they buy DIFFERENT things — stated
    // separately because they are not one guard:
    //   - `modelsSearchableAttributes`: the STRUCTURAL half. A function-scoped
    //     `const modelsSearchableAttributes = [...]` shadows the import and satisfies the
    //     argument pin above, so without this the pin is a claim about a name, not a list.
    //     (The displayed-list guard this shape copies bans only its local's name, not its
    //     export's, so this is one assertion wider than the proven shape.)
    //   - `searchableAttributes`: the SPELLED half, and it is honest to call it that. It blocks a
    //     revert to the old function-local shape and an alias that happens to reuse that name; it
    //     does NOT close the alias class, because `const alias = modelsSearchableAttributes` is
    //     not caught by it. Measured: that mutant leaves this suite green.
    const declared = declaredNames();
    for (const name of ['searchableAttributes', 'modelsSearchableAttributes']) {
      expect(
        declared,
        `${INDEX_REL} must declare no local \`${name}\` — the export is passed straight through, so a local binding is the one thing that could be mutated between its declaration and the write`
      ).not.toContain(name);
    }

    // 🔴 And the export is FROZEN. Two reasons, and the second is what closes the gap the
    // assertions above leave open.
    //
    // (1) Hoisting a list to module scope trades a narrow hazard for a wider one if you stop
    // there: an export is handed out BY REFERENCE, so `modelsSearchableAttributes.push('*')`
    // anywhere in the process would widen the whitelist in one line. ../displayed-attributes.ts
    // measured exactly that on its own list and calls the unfrozen export "worse than the local
    // copy it replaced".
    //
    // (2) 🔴 IT IS THE ONLY THING COVERING THE MUTATION ROUTES NO SYNTACTIC WALK HERE SEES, and
    // two of them were measured surviving this whole suite: an alias under another name
    // (`const alias = modelsSearchableAttributes; alias.push('*')`) and the documented shorthand
    // hole (`const bag = { modelsSearchableAttributes }; bag.modelsSearchableAttributes.push('*')`)
    // — the tree-wide mutation ledger in ~/server/__tests__/models-displayed-attributes.test.ts
    // matches the bare `<name>.<mutator>` callee and neither of those spells it. Both THROW once
    // the list is frozen, measured with the control that makes the claim mean anything: on an
    // UNFROZEN array the same two routes widen it (`["name"]` → `["name","*"]`), and on the frozen
    // one both raise `TypeError: Cannot add property 4, object is not extensible`. So the freeze
    // is not belt-and-braces here — it is the mechanism, and the assertions above are what make a
    // widening visible at review time rather than only at runtime. That matters because this
    // list's only writer runs inside an `UNRUNNABLE_JOB_CRON` reset, where a throw could go years
    // unobserved.
    expect(
      Object.isFrozen(modelsSearchableAttributes),
      'modelsSearchableAttributes must stay frozen — it is the only thing closing the aliasing and shorthand mutation routes that no syntactic guard in this file can see'
    ).toBe(true);
    expect(() => modelsSearchableAttributes.push('*')).toThrow();
    expect(modelsSearchableAttributes).not.toContain('*');
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
    //   - **SEVEN** of this file's **13** cases failed there, every one by its OWN assertion and
    //     none by a thrown error: the projection call (`expected [] to have a length of 1`), the
    //     ordered literal, the `?? null` diagnostic, the filterable membership of the two axes,
    //     the declared/projected pairing, the write-only-id absence case, and the
    //     whitelist-verbatim case. ⚠️ BOTH FIGURES HAVE NOW BEEN WRONG TWICE. It said "Four cases"
    //     and listed the first four; it was corrected to "SIX of this file's 12" — where the 12
    //     was ALREADY wrong, the file holding 13 cases at the time. The seventh failure is new and
    //     has a real cause rather than an arithmetic one: hoisting the whitelist to
    //     ../searchable-attributes.ts means the verbatim case now fails at base, where the write
    //     still passes a function-local. That is this comment's own stated lesson biting a fourth
    //     time — re-run the measurement, never carry a figure forward.
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

    // 🔴 `INSIGHT_WRITE_ONLY_ATTR` is swept here too, and for it this is not a ride-along note:
    // it is the assertion that pins the DISPLAY mechanism, which is ONE of the four absences
    // "no search path can return it" rests on — a necessary condition, not the sufficient one.
    //
    // ⚠️ THIS COMMENT USED TO CALL IT "THE assertion that makes 'no search path can return it'
    // machine-checked", over an enumeration of "neither the filterable nor the sortable list
    // either" — i.e. verbatim the two-list enumeration this change exists to correct, and
    // contradicting this file's own header 400 lines up, which spells out FOUR. It is left as a
    // marked correction rather than deleted because of the failure it invites: a maintainer
    // trimming guards reads "THE assertion", concludes the searchable membership case is
    // redundant, and deletes the only check on the fourth list.
    //
    // The four, and where each is pinned: DISPLAYED here (and `attributesToRetrieve` can only
    // narrow WITHIN the displayed set, so it cannot re-admit a withheld attribute); FILTERABLE
    // and SORTABLE in `keeps the winning version id OFF …`; SEARCHABLE in that same case for the
    // list's contents, plus `applies that whitelist VERBATIM …` for what the engine is actually
    // given. Remove `insight` from the withheld ledger and this case goes red — which is the
    // intended cost of the DISPLAY route named at the projection site, and of that route only.
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

describe('🔴 onIndexSetup hands the ENGINE the frozen lists — behaviourally, not structurally', () => {
  // ⚠️ DELIBERATELY LAST IN THE FILE. `onIndexSetup` sorts `modelsFilterableAttributes` IN PLACE
  // ("Meilisearch stores sorted"), and that list is deliberately unfrozen for exactly that reason.
  // Running this before the membership cases above would reorder an imported array underneath
  // them. They happen to be order-insensitive today; this placement means they do not have to be.
  afterEach(() => {
    setupProbe.received.length = 0;
    vi.restoreAllMocks();
  });

  async function runSetup() {
    // `onIndexSetup` logs a line per write; silenced so a failure's output is the assertion.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { modelsSearchIndex } = await import('~/server/search-index/models.search-index');
    const processor = modelsSearchIndex as unknown as {
      setup: (args: { indexName: string }) => Promise<void>;
    };
    expect(
      typeof processor.setup,
      'the processor literal must carry `setup` — if this is `undefined` the identity mock of `createSearchIndexUpdateProcessor` did not take effect and every assertion below is vacuous'
    ).toBe('function');
    await processor.setup({ indexName: 'models_v9_TEST' });
    return setupProbe.received;
  }

  it('writes exactly these six settings, and nothing else', async () => {
    // 🔴 THE NON-VACUITY ASSERTION THE REST OF THIS DESCRIBE RESTS ON. A stub that is never called
    // records nothing, and `received.find(...) === undefined` would then read as a clean absence in
    // every case below rather than as a broken probe. Pinned as its own case so the failure names
    // the cause instead of showing up as three mysterious `toBeDefined()` failures.
    //
    // It is an exact SET rather than a `length > 0`, which buys a second thing: `onIndexSetup` is
    // where this index's settings are decided, so a SEVENTH write appearing here is a settings
    // change nobody reviewed. An EMPTY list means the probe is not reaching the function at all;
    // a list that is merely different means the function's write set moved. The diff says which.
    const received = await runSetup();
    expect(
      received.map((r) => r.method).sort(),
      "onIndexSetup's write set moved — an EMPTY received list means the client/index mocks are not reaching it, a DIFFERENT list means a settings write was added or removed"
    ).toEqual([
      'updateDisplayedAttributes',
      'updateFilterableAttributes',
      'updateRankingRules',
      'updateSearchableAttributes',
      'updateSortableAttributes',
      'updateTypoTolerance',
    ]);
  });

  it('🔴 gives the searchable write the frozen export ITSELF, with no `*` in it', async () => {
    // Identity, not equality — and the difference is the whole point of asserting behaviourally.
    // `toBe` says the engine received THE frozen module object, so there is no copy, no spread,
    // no helper return and no shadowing local anywhere between the declaration and the call. The
    // argument pin above can only say the call site SPELLS the module's name.
    //
    // 🔴 This is also what moves the two routes the freeze covers from RESET time to TEST time.
    // An alias (`const alias = modelsSearchableAttributes; alias.push('*')`) and the bag
    // shorthand (`const bag = { modelsSearchableAttributes }; bag.…push('*')`) are invisible to
    // every syntactic guard in this file and only THROW when `onIndexSetup` runs — which happens
    // in an `UNRUNNABLE_JOB_CRON` reset, where a throw could go years unobserved. This case runs
    // the function, so the throw lands in CI instead.
    const received = await runSetup();
    const write = received.find((r) => r.method === 'updateSearchableAttributes');
    expect(write, 'no searchableAttributes write reached the engine').toBeDefined();
    expect(
      write?.arg,
      'the engine must receive the frozen module export itself, not a copy of it'
    ).toBe(modelsSearchableAttributes);
    expect(write?.arg as string[]).not.toContain('*');
    expect((write?.arg as string[]).filter((a) => a.startsWith('insight'))).toEqual([]);
  });

  it('🔴 gives the displayed write the frozen export ITSELF, withholding sortMetrics', async () => {
    // The Creator Controls privacy boundary, finally asserted at the engine rather than at the
    // call site's source text. This subsumes the no-local ban in
    // ~/server/__tests__/models-displayed-attributes.test.ts BEHAVIOURALLY: a shadowing
    // `const modelsDisplayedAttributes = ['id', 'sortMetrics']` inside `onIndexSetup` is what the
    // engine would then be handed, and it is recorded here. That hole was live at this head —
    // one line, suite green at 144/144, typecheck clean — which is why both guards exist.
    const { modelsDisplayedAttributes } = await import(
      '~/server/search-index/displayed-attributes'
    );
    const received = await runSetup();
    const write = received.find((r) => r.method === 'updateDisplayedAttributes');
    expect(write, 'no displayedAttributes write reached the engine').toBeDefined();
    expect(
      write?.arg,
      'the engine must receive the frozen module export itself — a local copy or shadow is how the real download/tip figures of creators who hid them get published'
    ).toBe(modelsDisplayedAttributes);
    expect(write?.arg as string[]).not.toContain('sortMetrics');
  });
});
