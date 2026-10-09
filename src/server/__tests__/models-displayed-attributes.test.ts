import { readFileSync, readdirSync, statSync } from 'fs';
import ts from 'typescript';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  MODELS_WITHHELD_ATTRIBUTES,
  modelsDisplayedAttributes,
} from '~/server/search-index/displayed-attributes';

/**
 * `modelsDisplayedAttributes` is a privacy boundary. Meilisearch returns every stored attribute
 * unless this list narrows it, and `models_v9` documents store `sortMetrics` — the REAL
 * download/tipped values for creators who have hidden them via Creator Controls. Without this
 * whitelist applied, a masked creator's true numbers are in the search hit.
 *
 * The list existing is not the same as the list being applied: its only writer runs inside an
 * `UNRUNNABLE_JOB_CRON` reset, against the swap index. That is what the admin apply route is for.
 *
 * So two different things need pinning, and only the first is about the list's contents:
 *   1. the list still withholds what it exists to withhold, and has not drifted silently
 *   2. the SEAM — every writer of this setting reads THIS list, so the two cannot diverge
 */

const SRC = join(process.cwd(), 'src');

/**
 * Every call expression in a file, as the SOURCE TEXT of its callee and arguments.
 *
 * 🔴 This replaced ~80 lines of hand-rolled lexing, and the lesson is worth more than the code.
 * Each guard below looks for a code CONSTRUCT — "is this array mutated in place", "who calls this
 * setting's writer". Expressed as a text grep, every one of them matched the comment EXPLAINING the
 * hazard it searched for, so each needed the file's comments stripped first; that happened four
 * times on four different patterns. The stripping was then a regex (blind to quoting, and already
 * deleting real code on this tree), then a scanner (80 lines, blinder still on this tree, and its
 * own controls missed two of its biggest branches).
 *
 * Asking the PARSER retires the whole chain. A comment is not a call expression and neither is a
 * string literal, so no guard can match its own prose and nothing has to be stripped. Measured on
 * this tree: 4,548 non-test files, ~1.6 s, ZERO parse failures, and the same verdicts the text
 * versions produced. Against the six injection sites a review round used to measure the scanner —
 * which missed five of them — this catches six of six; the apparent seventh was a bare statement
 * dropped into JSX markup, which parses as JSX TEXT and cannot execute, and the same hazard written
 * inside a `{…}` expression container IS caught.
 *
 * `typescript` is already a devDependency, so this costs no new install.
 */
function callsIn(rel: string) {
  const text = readFileSync(join(SRC, rel), 'utf8');
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const calls: { callee: string; args: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      calls.push({
        callee: node.expression.getText(sf),
        args: node.arguments.map((a) => a.getText(sf)),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return calls;
}

/** Declarations of `const <name> = …` in a file, by name — the AST equivalent of the old text pin. */
function declaredNames(rel: string) {
  const text = readFileSync(join(SRC, rel), 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/**
 * Every .ts/.tsx file under src/, so the ledger below cannot be dodged by adding a new directory.
 * Callers filter out tests — note `.test.tsx` as well as `.test.ts`: colocated browser tests were
 * being scanned by the tree-wide guards until a review round pointed it out.
 */
function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('modelsDisplayedAttributes — the Creator Controls privacy boundary', () => {
  it('is FROZEN, so the export cannot be widened by reference', () => {
    // 🔴 The guard that closes the one-line leak, and it is behavioural rather than textual.
    //
    // History, because the reasoning took three attempts and each intermediate state read as safe:
    // the processor first held a local copy (mutable, and a `.push` on it passed the whole suite);
    // removing the local was claimed to close the class, and did not — the export is handed out by
    // reference, so `modelsDisplayedAttributes.push('sortMetrics')` re-opened the leak in one line
    // and also passed, measured. Freezing is what actually closes it: the push throws.
    //
    // Asserted here so the freeze cannot be deleted quietly, which is the only way back to that
    // state.
    expect(Object.isFrozen(modelsDisplayedAttributes)).toBe(true);
    expect(Object.isFrozen(MODELS_WITHHELD_ATTRIBUTES)).toBe(true);
    expect(() => (modelsDisplayedAttributes as string[]).push('sortMetrics')).toThrow();
    expect(modelsDisplayedAttributes).not.toContain('sortMetrics');
  });

  it('is mutated in place by nobody — nor is any other FROZEN attribute-list export', () => {
    // Belt to the freeze's braces, and it covers the whole tree rather than one file: the freeze
    // makes a mutation THROW at runtime, this makes the attempt visible at review time. Which
    // matters more than it sounds for these lists — their only writer runs inside an
    // `UNRUNNABLE_JOB_CRON` reset, so a throw placed there could go years unobserved.
    //
    // Scoped to the frozen exports BY NAME, because the hazard is mutation of THESE arrays, not of
    // arrays in general — `models.search-index.ts` legitimately sorts `modelsFilterableAttributes`
    // in place, which is also why that list is not frozen and must not be added here.
    //
    // 🔴 `modelsSearchableAttributes` lives in `~/server/search-index/searchable-attributes.ts` and
    // is covered here rather than in its own file's guard, so the rule has ONE home. It is the
    // fourth attribute list, hoisted out of `onIndexSetup` because being a function-local `const`
    // while the other three were module exports is what made a mutation guard on it escapable; it
    // inherited this file's by-reference hazard in the same move, and is frozen for the same
    // reason. Its other guards — the write-argument pin, the no-local-binding ban and the freeze
    // assertion — are in
    // `~/server/search-index/__tests__/models-index-insight-projection.test.ts`.
    const MUTATOR =
      /^(modelsDisplayedAttributes|MODELS_WITHHELD_ATTRIBUTES|modelsSearchableAttributes)\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/;
    const offenders = walk(SRC)
      .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))
      .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel))
      .filter((rel) => callsIn(rel).some((c) => MUTATOR.test(c.callee)));

    expect(offenders).toEqual([]);
  });

  it('withholds sortMetrics', () => {
    // The single assertion this whole module exists for. Listing `sortMetrics` here would return
    // the true download/tipped figures of every creator who asked for them to be hidden.
    expect(modelsDisplayedAttributes).not.toContain('sortMetrics');
  });

  it('withholds every attribute it claims to withhold', () => {
    // Pins the RELATIONSHIP rather than one side of it: a future entry added to the withheld list
    // is only actually withheld if it is also absent here. Asserting `sortMetrics` alone would let
    // the next sort-only field be added to both lists and leak.
    //
    // 🔴 NOT redundant against the whole-list pin below, and an audit round read it as redundant —
    // so the reasoning is written down rather than left to be re-derived. The pin is DESIGNED TO BE
    // UPDATED ("the intended cost of changing the list"), which is exactly what the developer
    // adding the next sort-only field will do. Hold the pin's string fixed and yes, this cannot
    // fail alone; but in the scenario it exists for the pin has already been edited to match, and
    // this loop is then the ONLY thing standing between a new withheld attribute and a leak.
    // A guard is redundant only if it cannot fail where the other passes — test that against the
    // workflow, not against the current file contents.
    for (const attr of MODELS_WITHHELD_ATTRIBUTES) {
      expect(modelsDisplayedAttributes, `${attr} must not be displayed`).not.toContain(attr);
    }

    // Pin the withheld set itself, for the same reason the display list is pinned below: this list
    // IS the safety record for a privacy boundary, and a membership loop cannot see an entry going
    // MISSING. It shipped missing `flags` — written into this same index by the second writer,
    // `src/pages/api/mod/search/models-update.ts` — and a review round caught that, not a test.
    // A list that reads as the record while being incomplete is what stops the next person looking.
    // `insight` is the models index's suitability object — the sortable+filterable
    // `insight.qualityScore`, the filter-only meaning axes `insight.role` and
    // `insight.styleFamily`, and `insight.modelVersionId`, which is declared in NO attribute list
    // at all. No consumer reads any of them off a hit: the resource-intent matcher reads its
    // labels from Postgres. ONE top-level entry covers all FOUR, because
    // `transformData` emits `insight: { qualityScore, role, styleFamily, modelVersionId }` and both
    // withholding paths are keyed on the top-level attribute — Meili's `displayedAttributes` (where
    // nested children ride along with their parent) and `withheldStripped`'s `delete out[attr]`.
    // 🔴 For `modelVersionId` that ride-along is not incidental: removing `insight` from this
    // list would publish a field the projection site argues must stay unreadable, and it is the
    // only one of the four with no other list keeping it out of a serialised hit.
    // ⚠️ THAT USED TO READ "being undisplayed is the ONLY thing making it unreadable, since it is
    // not filterable either", AND THAT ENUMERATION WAS INCOMPLETE — the same incompleteness this
    // change corrected at the projection site. There are FOUR attribute lists, not two:
    // `displayedAttributes`, `filterableAttributes`, `sortableAttributes`, and the
    // `modelsSearchableAttributes` whitelist in `~/server/search-index/searchable-attributes.ts`
    // (a function-local literal in `onIndexSetup` until it was hoisted). The fourth is a whitelist
    // standing in for Meili's `["*"]` default, so widening it is a live route to reachability
    // with no edit to this file at all. Measured on a local Meilisearch 1.54.0, two documents
    // carrying `42` and `77`, with positive and negative controls: with the real whitelist
    // `q=42` returns 0 hits; with `["*"]` it returns 1, `q=77` returns the OTHER document
    // (per-document discrimination), and `q=999` returns 0.
    // 🔴 WHY THAT MATTERS TO A READER OF THIS LINE: a search-relevance change that widens
    // `searchableAttributes` to `["*"]`, justified by "the field is undisplayed and unfilterable,
    // so this is safety-neutral", ships a working MEMBERSHIP ORACLE on internal label outcomes
    // to anyone holding the browser-published client key in `src/env/client-schema.ts`. It is an
    // oracle, not a value leak — "which model carries this value", one guess at a time — because
    // the hit body still withholds `insight`: measured, the hit stays `{"id":1,"name":"a model"}`
    // even under `attributesToRetrieve: ["*"]`.
    // ⚠️ AND A BARE `'insight'` PARENT ENTRY IS A REAL ROUTE, not only a leaf one: with
    // `searchableAttributes: ["name","insight"]` — the parent alone — `q=42` returns 1 hit and
    // `q=render_3d` returns 1 hit, while the leaf-only `["name","insight.role"]` returns 0 for
    // `42`. That is why the projection guard's filter is `startsWith('insight')` and NOT
    // `startsWith('insight.')`: the dotless parent would slip a `'insight.'` test.
    expect([...MODELS_WITHHELD_ATTRIBUTES].sort().join(',')).toBe(
      'canGenerateNext,flags,insight,isOfficial,sortMetrics'
    );
  });

  it('🔴 is enforced on the DB-DIRECT path too, which displayedAttributes cannot reach', async () => {
    // The gap this closes: `displayedAttributes` governs only the MEILISEARCH read path.
    // `getModelSearchIndexRecords` builds the same records straight from the DB — its
    // docstring says "the shape stays identical to a search hit" — and they go to
    // `transformModelHits` (a bare `{...item}` spread) and out of `model.getResourceSelect`,
    // a `publicProcedure` with no `.output()` schema. So every withheld attribute was
    // returned to unauthenticated callers by the one path this whitelist cannot see,
    // including `sortMetrics` — the REAL download/tip values for creators who hid them,
    // i.e. exactly the leak this file exists to close.
    //
    // Asserted behaviourally and driven off the list, so a NEW withheld attribute is
    // covered the moment it is added rather than needing a new case here.
    const { withheldStripped } = await import('~/server/search-index/models.search-index');
    const record = {
      id: 1,
      name: 'a model',
      metrics: { downloadCount: null },
      ...Object.fromEntries(MODELS_WITHHELD_ATTRIBUTES.map((a) => [a, 'LEAKED'])),
    };
    const out = withheldStripped(record) as Record<string, unknown>;
    for (const attr of MODELS_WITHHELD_ATTRIBUTES) {
      expect(out, `${attr} must not survive onto the DB-direct path`).not.toHaveProperty(attr);
    }
    // And it must not strip anything else — a whitelist bug here blanks the search card.
    expect(out.id).toBe(1);
    expect(out.name).toBe('a model');
    expect(out.metrics).toEqual({ downloadCount: null });
  });

  it('matches the exact list, so any edit has to be read by a reviewer', () => {
    // A membership test cannot see an attribute being REMOVED, and removing one silently stops a
    // field being returned to clients that read it — a break that surfaces as `undefined`, not an
    // error. Pinning the whole normalised list makes every edit, in either direction, visible.
    // Updating this string is the intended cost of changing the list.
    expect(modelsDisplayedAttributes.join(',')).toBe(
      'id,name,type,nsfw,nsfwLevel,minor,sfwOnly,status,createdAt,lastVersionAt,' +
        'lastVersionAtUnix,publishedAt,locked,earlyAccessDeadline,hasActivePaidAccess,mode,' +
        'checkpointType,availability,poi,user,category,permissions,version,versions,triggerWords,' +
        'fileFormats,hashes,tags,metrics,rank,hiddenMetrics,canGenerate,cannotPromote,cosmetic,' +
        'images'
    );
  });

  it('displays `versions`, so the per-version coverage flag the client reads survives', () => {
    // `canGenerateNext` is withheld at the TOP level but `versions.canGenerateNext` is read by
    // coverage-fields.ts / resource-select.types.ts. Meili whitelists by top-level attribute and
    // nested children ride along, so dropping `versions` would take that flag with it.
    //
    // 🔴 Same non-redundancy as the loop above, and the same audit round read it the same way: this
    // pins a COUPLING between the two exports that the whole-list pin cannot express. Whoever drops
    // `versions` will update the pin string in the same edit — and this is what then fails, naming
    // the consequence instead of printing a string diff.
    expect(modelsDisplayedAttributes).toContain('versions');
    expect(MODELS_WITHHELD_ATTRIBUTES).toContain('canGenerateNext');
  });
});

describe('the writer seam', () => {
  it('has exactly two writers of displayedAttributes, and both read the shared list', () => {
    // A ledger, not a spot check: it fails when the writer set GROWS (a third writer with its own
    // copy of the list — the drift this module was extracted to prevent) and when it SHRINKS (a
    // writer deleted, so applying the list somewhere stopped happening). Either way a human reads
    // this test before the set changes.
    //
    // Why a ledger at all: before this change the list lived inline in onIndexSetup, so the admin
    // route could only have had its own copy, and a copy that disagrees with `reset()` means the
    // live index ends up in a state no code describes.
    // 🔴 Excluding tests is load-bearing, not tidiness: this file names the very string it
    // searches for, so without the filter the scan matches ITSELF and the ledger can never be
    // satisfied. Same shape as `pgrep -f` matching the shell that ran it.
    const writers = walk(SRC)
      .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))
      .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel))
      .filter((rel) =>
        callsIn(rel).some((c) => c.callee.split('.').pop() === 'updateDisplayedAttributes')
      )
      .sort();

    expect(writers).toEqual([
      'pages/api/admin/temp/apply-models-index-displayed-attributes.ts',
      'server/search-index/models.search-index.ts',
    ]);

    for (const w of writers) {
      expect(
        readFileSync(join(SRC, w), 'utf8'),
        `${w} must read the shared list, not its own copy`
      ).toContain('modelsDisplayedAttributes');
    }
  });

  it('has exactly nine writers of searchableAttributes, tree-wide', () => {
    // 🔴 THE MISSING THIRD GUARD, AND THE ONLY TREE-WIDE ONE. The displayed list is protected by
    // three guards of different SHAPES — this writer ledger, the write-argument pin, and the
    // no-local ban — and when the same protection was built for the searchable whitelist in
    // ~/server/search-index/__tests__/models-index-insight-projection.test.ts only the latter two
    // were copied. Both of those walk `models.search-index.ts` and nothing else, so a writer in a
    // SECOND file was invisible to every guard in the set.
    //
    // 🔴 Measured, not hypothesised. Adding
    // `src/pages/api/admin/temp/apply-models-index-searchable-attributes.ts` — the exact analogue
    // of the two admin routes already in this tree (`apply-models-index-filterable-attributes.ts`
    // and `apply-models-index-displayed-attributes.ts`) — with
    //     const index = searchClient.index(MODELS_SEARCH_INDEX);
    //     const task = await index.updateSearchableAttributes(['*']);
    // left the whole suite green and `pnpm typecheck` at 0 errors,
    // while the LIVE models index would end up with `searchableAttributes: ["*"]` — i.e. every
    // `insight.*` leaf, `insight.modelVersionId` included, becomes a per-document free-text
    // MEMBERSHIP ORACLE to any holder of the browser-published client key in
    // `src/env/client-schema.ts`. Nothing fired: the freeze is untouched (a fresh array literal),
    // the argument pin and the local ban walk only the index file, the membership case reads the
    // unmodified export, and the MUTATOR ledger above matches only `<name>.<mutator>`.
    // The positive control that makes this an omission rather than an impossibility: the identical
    // shape against the DISPLAYED list IS caught, by the ledger directly above this one.
    //
    // 🔴 WHY IT LIVES IN THIS FILE RATHER THAN BESIDE THE OTHER SEARCHABLE GUARDS. Same reason the
    // MUTATOR regex above covers `modelsSearchableAttributes`: the tree-wide walks have ONE home,
    // so `walk`/`callsIn` are not duplicated and a reviewer finds every tree-wide ledger together.
    //
    // 🔴 AND WHY THE SET IS THE NINE INDEX FILES RATHER THAN "the models index's writers". Which
    // index a `*.search-index.ts` writes is decided by a runtime `indexName`, so no syntactic walk
    // can scope this ledger to the models index — the honest scope is every caller of the setter,
    // anywhere. The cost is that it also moves when an unrelated index gains or loses a searchable
    // write, which is the review event we want: a NEW writer is the hazard, and a writer
    // DISAPPEARING means an index stopped having its whitelist applied at all and silently fell
    // back to Meili's `["*"]`.
    const writers = walk(SRC)
      .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))
      .filter((rel) => !rel.includes('__tests__/') && !/\.test\.tsx?$/.test(rel))
      .filter((rel) =>
        callsIn(rel).some((c) => c.callee.split('.').pop() === 'updateSearchableAttributes')
      )
      .sort();

    expect(writers).toEqual([
      'server/search-index/articles.search-index.ts',
      'server/search-index/bounties.search-index.ts',
      'server/search-index/collections.search-index.ts',
      'server/search-index/comics.search-index.ts',
      'server/search-index/images.search-index.ts',
      'server/search-index/metrics-images.search-index.ts',
      'server/search-index/models.search-index.ts',
      'server/search-index/tools.search-index.ts',
      'server/search-index/users.search-index.ts',
    ]);

    // 🔴 ONLY the models index is required to read the shared export, and that asymmetry is
    // DELIBERATE and documented: the other eight index files each declare their own inline
    // `searchableAttributes` literal, which is out of scope here and not a defect to be swept up.
    // Asserting the shared read across all nine would be a redesign of eight unrelated indexes
    // dressed up as a guard.
    // Note `~/server/search-index/searchable-attributes.ts` is correctly ABSENT from the ledger
    // above: it names `updateSearchableAttributes` in a prose comment, and a comment is not a call
    // expression, which is the whole reason these walks ask the parser instead of the text.
    expect(
      readFileSync(join(SRC, 'server/search-index/models.search-index.ts'), 'utf8'),
      'models.search-index.ts must read the shared whitelist, not its own copy'
    ).toContain('modelsSearchableAttributes');
  });

  it('passes the shared module STRAIGHT to the processor write, with no local in between', () => {
    // Pin the ARGUMENT, which is the only thing that decides what the live index ends up with.
    //
    // Two earlier versions of this guard were both too weak, and each was found by measurement
    // rather than by reading:
    //   1. keying on two attribute LITERALS (`'hiddenMetrics',`, `'earlyAccessDeadline',`) was
    //      SPELLED, not structural — a double-quoted inline copy omitting both passed it.
    //   2. pinning the initialiser statement `const displayedAttributes = [...module]` was
    //      structural but pinned the WRONG EXPRESSION: a `displayedAttributes.push('sortMetrics')`
    //      on the next line re-opened the leak and passed the entire suite.
    //
    // The processor now has no local binding at all — it passes the module export directly — so
    // there is nothing left to mutate between declaration and call. This asserts that: exactly one
    // write, and its argument is the bare module name.
    const PROC = 'server/search-index/models.search-index.ts';
    const calls = callsIn(PROC).filter(
      (c) => c.callee.split('.').pop() === 'updateDisplayedAttributes'
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['modelsDisplayedAttributes']);

    // And no local binding to shadow it, which is how the mutate-the-copy shape got in.
    //
    // 🔴 BOTH NAMES, and the second one was MISSING until it was measured. Banning only the old
    // function-local's name (`displayedAttributes`) leaves the argument pin above as a claim about
    // a NAME rather than about a LIST: a
    //   `const modelsDisplayedAttributes = ['id', 'sortMetrics'];`
    // inserted after `const settings = await index.getSettings();` shadows the frozen import inside
    // `onIndexSetup`, satisfies the pin (the argument text is still the bare module name), and hands
    // the engine `['id','sortMetrics']` — i.e. it PUBLISHES the real download and tipped figures of
    // every creator who hid them, the single thing this module exists to prevent. Measured at this
    // head with that one line planted: the whole suite green and `pnpm typecheck` 0 errors.
    //
    // ⚠️ SUITE TOTALS ARE DELIBERATELY NOT QUOTED IN THIS FILE OR ITS SIBLING. They were, as
    // `Tests 144 passed (144)` at five sites, and the commit that wrote four of them ADDED four
    // cases, so every one was stale the moment it landed (the tree is at 148). A total is not what
    // these notes are claiming — "the mutant went uncaught" is — and this arc has now corrected a
    // bare count six times. State the corpus or state nothing; do not re-add a total.
    // Nothing else could see it — the freeze does not apply to a fresh
    // local, the tree-wide mutation ledger sees no mutation, and the whole-list pin reads the
    // IMPORT, not what the function resolved.
    //
    // The two halves buy different things, so they are listed rather than merged:
    //   - `modelsDisplayedAttributes`: the STRUCTURAL half — it is the name the write argument
    //     actually resolves, so this is what makes the pin above mean the frozen export.
    //   - `displayedAttributes`: the SPELLED half, and it is honest to call it that. It blocks a
    //     revert to the old function-local shape and an alias reusing that name; it does NOT close
    //     the alias class (`const alias = modelsDisplayedAttributes` is not caught by it).
    //
    // An ImportSpecifier is not a VariableDeclaration, so `declaredNames` does not see this file's
    // own import of the export and the ban cannot false-fire on it.
    // The same pair, for the same reason, guards the searchable whitelist in
    // ~/server/search-index/__tests__/models-index-insight-projection.test.ts.
    const declared = declaredNames(PROC);
    // 🔴 Positive control, because a reassuring zero and a walk wired to nothing are
    // indistinguishable: if `declaredNames` resolved nothing, every `not.toContain` below would be
    // vacuously true. The projection file's copy of this helper asserts the same thing internally.
    expect(
      declared.length,
      `declarations must be readable in ${PROC} — 0 means this walk is wired to nothing and every \`not.toContain\` over it is vacuous`
    ).toBeGreaterThan(0);
    for (const name of ['displayedAttributes', 'modelsDisplayedAttributes']) {
      expect(
        declared,
        `${PROC} must declare no local \`${name}\` — the frozen export is passed straight through, so a local binding of EITHER name is the one thing that could stand between its declaration and the write`
      ).not.toContain(name);
    }
  });
});
