import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';

/**
 * SEAM GUARD — the `classifyGatedImageForViewer` CALL-SITE LEDGER.
 *
 * The verdict has a third state (`pending` — nothing has rated this image yet)
 * that the WIRE type does not: `getBlockGatedImagesByIds` consumes it, turning it
 * into `visible` + `ratingPending` for the image's own author and into `hidden`
 * for everyone else. Every OTHER consumer must keep treating anything that is not
 * `visible` as a refusal, and must do so by spelling the test `!== 'visible'`: a
 * gate written `=== 'hidden'` was correct while the verdict had two members and
 * silently ADMITS a `pending` image now. Neither file is wrong on its own, so nothing
 * fails until someone writes a per-consumer case for the new state: the two ledgered
 * consumers have one, and a third would not.
 *
 * The BEHAVIOURAL half lives with each consumer and is deliberately not duplicated
 * here — see `block-post.service.test.ts` and `block-gated-images.service.test.ts`.
 */

const SRC = resolve(__dirname, '../../../..'); // …/src
const SYMBOL = 'classifyGatedImageForViewer';

/** The module that DEFINES the symbol — never a call site. */
const DEFINITION = 'server/services/blocks/block-gated-images.logic.ts';

/**
 * An `import … from '<anything>/block-gated-images.logic'` — the alias-proof half
 * of the detection. Matches any prefix, `~/`-rooted or relative, with no extension
 * or a `.ts`/`.tsx`/`.js`/`.jsx` one and nothing else, and (because the source is
 * comment-stripped first) cannot be satisfied by prose that merely names the module.
 * `export … from` is matched by the same `from` clause, so a re-export is a call
 * site too.
 */
const LOGIC_MODULE_IMPORT = /from\s*['"][^'"]*block-gated-images\.logic(?:\.[jt]sx?)?['"]/;

/**
 * The ledger. Adding a consumer means adding it HERE, which is the point: the
 * decision "what does this surface do with an image nothing has rated yet?" has
 * to be made by a person, once, per surface.
 */
const EXPECTED_CALL_SITES = [
  // The grid projection — the ONE place allowed to branch on `pending`, and the
  // only place with the image's author in hand to do it safely.
  'server/services/blocks/block-gated-images.service.ts',
  // The public-Post adoption gate — must REFUSE anything not `visible`.
  'server/services/blocks/block-post.service.ts',
].sort();

/** Files that may gate on `=== 'hidden'` (i.e. the projection, which handles
 *  every state explicitly rather than by a binary refusal). */
const MAY_BRANCH_ON_HIDDEN = new Set(['server/services/blocks/block-gated-images.service.ts']);

/**
 * Every literal in this file is POSIX and `relative()` answers in the host's separator, so a rel
 * is normalised at the one place it is produced. `replace` rather than `split(sep)`: the latter
 * is the identity on Linux, which makes the assertion pinning it unfalsifiable on CI.
 */
const toPosix = (path: string) => path.replace(/\\/g, '/');
const toRel = (full: string) => toPosix(relative(SRC, full));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isTestPath = (rel: string) =>
  rel.includes('__tests__') || /\.test\.tsx?$/.test(rel) || /(^|\/)tests\//.test(rel);

const PRODUCTION_FILES = walk(SRC).filter((f) => !isTestPath(toRel(f)));

/**
 * The raw-text gate that runs BEFORE `isCallSite` and decides what it ever sees. A strict
 * superset of both halves of `isCallSite` — the import half needs the literal
 * `block-gated-images.logic`, the call half needs `SYMBOL`, and
 * stripping only ever REMOVES text, so a file lacking both raw cannot gain either. It keeps a
 * char-by-char scan off the thousands of files that obviously do not matter.
 *
 * Named rather than inlined so a control can put a fixture through the same predicate the loop
 * uses: `verdictFor` writes straight into `SOURCE` and runs past this stage.
 */
const couldBeCallSite = (raw: string) =>
  raw.includes('block-gated-images.logic') || raw.includes(SYMBOL);

const SOURCE = new Map<string, string>();
for (const full of PRODUCTION_FILES) {
  const raw = readFileSync(full, 'utf8');
  if (!couldBeCallSite(raw)) continue;
  SOURCE.set(toRel(full), stripSourceComments(raw));
}

/**
 * A file is a call site if it IMPORTS the logic module or names the symbol in call
 * position. Each half pins a SPELLING: a `from` clause in the forms listed on
 * `LOGIC_MODULE_IMPORT`, and the literal `SYMBOL(`. Escaping both takes a file that
 * writes neither — reaching the module some way that regex does not list (a barrel, an
 * `import()`, an unlisted extension) AND reaching the function under another name.
 */
function isCallSite(rel: string): boolean {
  if (rel === DEFINITION) return false;
  const code = SOURCE.get(rel) ?? '';
  return LOGIC_MODULE_IMPORT.test(code) || code.includes(`${SYMBOL}(`);
}

const SYNTHETIC_REL = 'server/services/blocks/__synthetic_consumer__.ts';

/**
 * Routes a synthetic source through `isCallSite` itself. Do not refactor this to call a pure
 * predicate extracted out of `isCallSite`: that leaves the rule in two places and pins the copy
 * the ledger does not use.
 */
function verdictFor(source: string, rel: string = SYNTHETIC_REL): boolean {
  // The delete is unconditional, so a real file at this rel would be evicted from the corpus
  // for the rest of the run.
  if (SOURCE.has(rel)) throw new Error(`${rel} exists; pick another rel`);
  SOURCE.set(rel, source);
  try {
    return isCallSite(rel);
  } finally {
    SOURCE.delete(rel);
  }
}

describe(`${SYMBOL} seam`, () => {
  // POSITIVE CONTROL for the scanner itself: if this walk could not see the
  // definition module, a ZERO call-site count below would be a fact about the
  // walk, not about the codebase.
  it('the file walk actually reaches the module under test', () => {
    const rels = [...SOURCE.keys()];
    expect(rels).toContain(DEFINITION);
    // `verdictFor` seeds `SOURCE` directly, so no detector fixture runs the corpus loop and none
    // can observe it narrowing by path. Every corpus member's path also contains the token
    // `blocks`, so narrowing the loop by that token excludes nothing and stays green. Re-derive
    // from the same walk instead: a filter added to the LOOP makes the two disagree.
    // Both shared inputs are pinned elsewhere — `PRODUCTION_FILES` by the enumeration equality
    // above, `couldBeCallSite` by its own case — so deleting either makes this one vacuous.
    const expectedCorpus = PRODUCTION_FILES.filter((full) =>
      couldBeCallSite(readFileSync(full, 'utf8'))
    )
      .map(toRel)
      .sort();
    expect(expectedCorpus.length).toBeGreaterThan(0);
    expect([...SOURCE.keys()].sort()).toEqual(expectedCorpus);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(500);

    // Enumerated by a different mechanism than `walk`, with the test-path rule spelled out again
    // rather than shared: sharing `isTestPath` moves both sides together, so widening it hides
    // whole trees from the ledger with this assertion still green. Equality rather than
    // containment, so narrowing EITHER side reddens.
    const scanned = PRODUCTION_FILES.map(toRel).sort();
    const enumerated = readdirSync(SRC, { recursive: true, withFileTypes: true })
      // `components/ActionIconInput.tsx` is a DIRECTORY — an extension test is not a file test.
      .filter((entry) => entry.isFile())
      .map((entry) => toRel(join(entry.parentPath, entry.name)))
      .filter(
        (rel) =>
          /\.tsx?$/.test(rel) &&
          !rel.includes('__tests__') &&
          !/\.test\.tsx?$/.test(rel) &&
          !/(^|\/)tests\//.test(rel) &&
          !/(^|\/)(node_modules|\.next)\//.test(rel)
      )
      .sort();
    expect(enumerated.length).toBeGreaterThan(3000);
    expect(scanned).toEqual(enumerated);

    // Kept beside the equality as a second, differently-failing route: this one names the tree
    // that went missing, where the equality names four thousand paths.
    for (const tree of ['components/', 'pages/', 'utils/']) {
      expect(
        scanned.some((rel) => rel.startsWith(tree)),
        `the walk no longer reaches ${tree} — the ledger cannot see a consumer added there`
      ).toBe(true);
    }
  });

  // Pinned three ways because the normalisation has two removable halves and they fail on
  // different hosts: the helper's body (caught on any host, hardcoded input), the call to it
  // inside `toRel` (caught on Windows, where `join` produces a separator to fold), and the
  // walk's real output (the only one observing what the guard actually keyed the ledger on).
  it('normalises a host-separated rel to the POSIX form the ledger is written in', () => {
    expect(toPosix('server\\services\\blocks\\block-gated-images.logic.ts')).toBe(DEFINITION);
    // Mixed case: `toRel` produces BOTH sides of the walk-coverage equality, so a normalisation
    // that lowercased every rel would leave them identically wrong and still equal.
    expect(toRel(join(SRC, 'components', 'AppBlocks', 'x.tsx'))).toBe('components/AppBlocks/x.tsx');
    expect(toRel(join(SRC, 'server', 'services', 'blocks', 'block-gated-images.logic.ts'))).toBe(
      DEFINITION
    );
    const rels = [...SOURCE.keys()];
    // Without this the filter below is `[].filter()` and passes on an empty walk; the walk
    // control that would rule that out is in another `it`, so this one cannot rely on it.
    expect(rels.length).toBeGreaterThan(0);
    expect(rels.filter((rel) => rel.includes('\\'))).toEqual([]);
  });

  // POSITIVE CONTROL for the DETECTOR: a ledger assertion never watched to match anything is
  // indistinguishable from one wired to nothing. Assert through `verdictFor`, never against
  // `LOGIC_MODULE_IMPORT` directly — both real consumers satisfy both halves of the union in
  // `isCallSite`, so a regex-level case stays green if the union narrows to an intersection.
  it('the detector matches an ALIASED import (the shape that walked the old ledger)', () => {
    const aliased = `import { ${SYMBOL} as classify } from '~/server/services/blocks/block-gated-images.logic';\nif (classify(row, level).status === 'hidden') {}\n`;
    expect(verdictFor(aliased)).toBe(true);
    // The old spelled-only rule does NOT match it, so the green above is about the new rule.
    expect(aliased.includes(`${SYMBOL}(`)).toBe(false);

    for (const source of [
      `import { ${SYMBOL} } from '~/server/services/blocks/block-gated-images.logic';`,
      `import { ${SYMBOL} as c } from './block-gated-images.logic';`,
      `import * as gate from '../blocks/block-gated-images.logic';`,
      `import { ${SYMBOL} } from './block-gated-images.logic.js';`,
      `export { ${SYMBOL} } from '~/server/services/blocks/block-gated-images.logic';`,
    ]) {
      expect(verdictFor(source), source).toBe(true);
    }

    // Both spellings: a dotted-only arm leaves `.SYMBOL(` a green mutant while losing the bare
    // call a name-preserving re-export produces.
    expect(verdictFor(`gate.${SYMBOL}(row, level);`)).toBe(true);
    expect(verdictFor(`const verdict = ${SYMBOL}(row, level);`)).toBe(true);

    // NEGATIVE controls. The second varies only the symbol half, which pins the `(` — without it
    // the detector can degrade from "calls it" to "mentions it" and stay green.
    expect(verdictFor('see block-gated-images.logic.ts for the clamp')).toBe(false);
    expect(verdictFor(`const doc = '${SYMBOL}';`)).toBe(false);

    // The REL is an input to `isCallSite` too, and every fixture above passes one inside
    // `server/services/blocks/` — as are both ledgered call sites, so scoping the detector to
    // that prefix stays green while a consumer added anywhere else never joins the ledger.
    expect(verdictFor(aliased, 'components/ImageGuard2/__synthetic_consumer__.tsx')).toBe(true);
    expect(verdictFor(aliased, 'server/services/__synthetic_consumer__.ts')).toBe(true);
    expect(verdictFor(aliased, 'pages/api/v1/__synthetic_consumer__.ts')).toBe(true);
    // Pins the occupancy throw in `verdictFor`.
    expect(() => verdictFor(aliased, DEFINITION)).toThrow();

    expect(SOURCE.has(SYNTHETIC_REL), 'the synthetic source outlived its test').toBe(false);
  });

  // The module half is what admits a consumer that imports without spelling the symbol — drop it
  // and a re-exporting barrel never reaches the detector at all. Every spelling, for the same
  // reason the detector control enumerates spellings: one fixture pins one spelling, and the
  // predicate can be narrowed to exactly that literal while staying green. (A substring test
  // cannot tell the relative forms apart — the rooted/relative pair is what discriminates.)
  it('the corpus pre-filter admits a file that names the module but not the symbol', () => {
    for (const barrel of [
      `export * from '~/server/services/blocks/block-gated-images.logic';\n`,
      `export * from './block-gated-images.logic';\n`,
      `export { something } from '../blocks/block-gated-images.logic';\n`,
      `export * from './block-gated-images.logic.js';\n`,
    ]) {
      expect(barrel.includes(SYMBOL), barrel).toBe(false);
      expect(couldBeCallSite(barrel), barrel).toBe(true);
    }
    expect(couldBeCallSite(`const v = ${SYMBOL}(row, level);\n`)).toBe(true);
    expect(couldBeCallSite('export const unrelated = 1;\n')).toBe(false);
  });

  // The two derivations of the test-path rule are written from each other, so they can agree on
  // the same mistake: editing only one copy reddens the equality above, a mistake made in BOTH
  // is green there, and this case is the only thing that sees it. The `(^|\/)tests\//` anchor
  // exists because `includes('/tests/')` matched nothing on a rel with no leading slash.
  it('classifies test paths', () => {
    expect(isTestPath('components/Foo/__tests__/Foo.test.tsx')).toBe(true);
    expect(isTestPath('tests/api/v1/download-url-seam.helper.ts')).toBe(true);
    expect(isTestPath('server/services/latest-tests.service.ts')).toBe(false);
    // 'contests/' contains 'tests/', so an unanchored rule would evict real route files.
    expect(isTestPath('pages/moderator/contests/index.tsx')).toBe(false);
    expect(isTestPath('server/services/blocks/block-post.service.ts')).toBe(false);
  });

  // The strip runs at load, so nothing reading `SOURCE` can observe that it ran.
  it('strips comments before the detector reads a file', () => {
    const strippedAMention = [...SOURCE.keys()].filter((rel) => {
      const raw = readFileSync(join(SRC, rel), 'utf8');
      return raw.includes(SYMBOL) && !SOURCE.get(rel)?.includes(SYMBOL);
    });
    expect(
      strippedAMention.length,
      'no file names the symbol only in prose — the strip is now unexercised, which is not by ' +
        'itself a bug'
    ).toBeGreaterThan(0);

    // The count above is satisfied by one file, so it cannot say WHICH comment kinds are
    // stripped: a stripper that stopped handling `//` would still ride on a block-comment
    // survivor. The line comment is indented and the second is trailing, because a
    // line-start-anchored stripper passes a column-0 fixture and is the regression this
    // module's own header records.
    expect(
      stripSourceComments(`  // if (v.status !== 'visible') return;\nconst a = 1;\n`)
    ).not.toContain(`status !== 'visible'`);
    expect(stripSourceComments(`const a = 1; // ${SYMBOL}(row, level);\n`)).not.toContain(
      `${SYMBOL}(`
    );
    // The other `stripSourceComments` arms are all `not.toContain`, which `() => ''` satisfies.
    expect(stripSourceComments(`  // x\nconst a = 1;\n`)).toContain('const a = 1');
    expect(stripSourceComments(`/** calls ${SYMBOL}(row, level) */\nconst a = 1;\n`)).not.toContain(
      `${SYMBOL}(`
    );
  });

  it('has exactly the ledgered call sites — no more, no fewer', () => {
    const found = [...SOURCE.keys()].filter(isCallSite).sort();
    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it("no consumer gates on `=== 'hidden'` — a `pending` image would walk past it", () => {
    const targets = EXPECTED_CALL_SITES.filter((rel) => !MAY_BRANCH_ON_HIDDEN.has(rel));
    // Named rather than counted: allow-listing the last consumer, or emptying the ledger, would
    // otherwise leave this case iterating nothing and reporting green.
    expect(targets).toEqual(['server/services/blocks/block-post.service.ts']);

    for (const rel of targets) {
      // Comments are already stripped, so the prose ABOVE the gate (which names
      // the wrong spelling in order to forbid it) cannot satisfy or trip this.
      // A ledger literal that stops matching a key would otherwise leave `code` empty, and the
      // prohibition below passes free on an empty string while only the positive half reddens.
      expect(SOURCE.has(rel), rel).toBe(true);
      const code = SOURCE.get(rel) ?? '';
      expect(code).not.toContain(`status === 'hidden'`);
      expect(code).toContain(`status !== 'visible'`);
    }
  });
});
