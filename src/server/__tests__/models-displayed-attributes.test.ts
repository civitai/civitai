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

  it('is mutated in place by nobody', () => {
    // Belt to the freeze's braces, and it covers the whole tree rather than one file: the freeze
    // makes a mutation THROW at runtime, this makes the attempt visible at review time. Scoped to
    // the two exports by name, because the hazard is mutation of THESE arrays, not of arrays in
    // general — `models.search-index.ts` legitimately sorts `modelsFilterableAttributes` in place.
    const MUTATOR =
      /^(modelsDisplayedAttributes|MODELS_WITHHELD_ATTRIBUTES)\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$/;
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
    // at all. No consumer reads any of them off a hit: the resource-intent matcher sorts on the
    // score and reads what it needs from Postgres. ONE top-level entry covers all FOUR, because
    // `transformData` emits `insight: { qualityScore, role, styleFamily, modelVersionId }` and both
    // withholding paths are keyed on the top-level attribute — Meili's `displayedAttributes` (where
    // nested children ride along with their parent) and `withheldStripped`'s `delete out[attr]`.
    // 🔴 For `modelVersionId` that ride-along is not incidental: being undisplayed is the ONLY
    // thing making it unreadable, since it is not filterable either, so removing `insight` from
    // this list would publish a field the projection site argues must stay unreadable.
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
    expect(declaredNames(PROC)).not.toContain('displayedAttributes');
  });
});
