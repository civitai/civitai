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
 * silently ADMITS a `pending` image now. That is not a bug in either file on its
 * own — each one type-checks, each one's unit tests pass — so it is exactly the
 * class of defect a per-file suite cannot see.
 *
 * This asserts the RELATIONSHIP, not a component:
 *   1. the exact SET of call sites (fails when it GROWS *or* SHRINKS, so a new
 *      consumer cannot join without a human deciding what it does with `pending`),
 *   2. that no call site outside the projection gates on `=== 'hidden'`.
 *
 * 🔴 (1) IS DETECTED BY THE IMPORT SPECIFIER, NOT BY THE SYMBOL'S SPELLING, AND
 * THAT IS THE WHOLE POINT. It used to be `source.includes('classifyGatedImageForViewer(')`
 * — a SPELLED check, walkable by writing the thing a different way. A third
 * consumer added as
 *
 *     import { classifyGatedImageForViewer as classify } from '…block-gated-images.logic';
 *     if (classify(row, level).status === 'hidden') { … }   // ADMITS `pending`
 *
 * is a real bypass of both assertions below, and this suite reported 85/85 green
 * over it. Binding the ledger to `from '…block-gated-images.logic'` pins the
 * thing that cannot be renamed away: you cannot call the function without
 * importing the module it lives in. The symbol-spelling test is KEPT as a second,
 * differently-failing route (a namespace import, a re-export) rather than
 * replaced — a file matching EITHER is a call site.
 *
 * The BEHAVIOURAL half lives with each consumer and is deliberately not duplicated
 * here: `block-post.service.test.ts` proves the public-Post adoption gate refuses
 * a `Pending`-ingestion and an unrated (`nsfwLevel: 0`) image, and
 * `block-gated-images.service.test.ts` proves the grid withholds the url from
 * every viewer but the image's own author. A structural check alone would
 * type-check past a wrong argument; those two are what make it mean something.
 */

const SRC = resolve(__dirname, '../../../..'); // …/src
const SYMBOL = 'classifyGatedImageForViewer';

/** The module that DEFINES the symbol — never a call site. */
const DEFINITION = 'server/services/blocks/block-gated-images.logic.ts';

/**
 * An `import … from '<anything>/block-gated-images.logic'` — the alias-proof half
 * of the detection. Matches the `~/`-rooted, relative and extensionless spellings
 * alike, and (because the source is comment-stripped first) cannot be satisfied by
 * prose that merely names the module. `export … from` is matched by the same
 * `from` clause, so a re-export is a call site too.
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
 * Comment-stripped source for every production file that could POSSIBLY be a call
 * site, read once.
 *
 * The pre-filter is on the RAW text and is a strict superset of both halves of
 * {@link isCallSite}: you cannot import the module without the literal
 * `block-gated-images.logic` appearing, nor call the function without `SYMBOL`
 * appearing — and comment-stripping only ever REMOVES text, so a file that lacks
 * both raw cannot gain either. It exists only to keep a char-by-char scan off the
 * ~1,700 files that obviously do not matter.
 */
/**
 * The raw-text gate that runs BEFORE `isCallSite` and decides what it ever sees. Named so a
 * control can put a fixture through the same predicate the loop uses: `verdictFor` writes
 * straight into `SOURCE`, so the detector cases run past this stage and cannot constrain it.
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
 * A file is a call site if it IMPORTS the logic module (alias-proof) OR names the
 * symbol in call position (namespace import / re-export). Either alone is
 * walkable; the union is what the ledger asserts.
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
function verdictFor(source: string): boolean {
  // The delete is unconditional, so a real file at this rel would be evicted from the corpus
  // for the rest of the run.
  if (SOURCE.has(SYNTHETIC_REL)) throw new Error(`${SYNTHETIC_REL} exists; pick another rel`);
  SOURCE.set(SYNTHETIC_REL, source);
  try {
    return isCallSite(SYNTHETIC_REL);
  } finally {
    SOURCE.delete(SYNTHETIC_REL);
  }
}

describe(`${SYMBOL} seam`, () => {
  // POSITIVE CONTROL for the scanner itself: if this walk could not see the
  // definition module, a ZERO call-site count below would be a fact about the
  // walk, not about the codebase.
  it('the file walk actually reaches the module under test', () => {
    const rels = [...SOURCE.keys()];
    expect(rels).toContain(DEFINITION);
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

    expect(SOURCE.has(SYNTHETIC_REL), 'the synthetic source outlived its test').toBe(false);
  });

  // The pre-filter decides what `isCallSite` is ever asked about, and `verdictFor` runs past it,
  // so nothing above constrains it. Its module half is what admits a consumer that imports
  // without spelling the symbol — drop that half and a re-exporting barrel never reaches the
  // detector at all.
  it('the corpus pre-filter admits a file that names the module but not the symbol', () => {
    const barrel = `export * from '~/server/services/blocks/block-gated-images.logic';\n`;
    expect(barrel.includes(SYMBOL)).toBe(false);
    expect(couldBeCallSite(barrel)).toBe(true);
    expect(couldBeCallSite(`const v = ${SYMBOL}(row, level);\n`)).toBe(true);
    expect(couldBeCallSite('export const unrelated = 1;\n')).toBe(false);
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
    // survivor. The line comment is indented and the third case is trailing, because a
    // line-start-anchored stripper passes a column-0 fixture and is the regression this
    // module's own header records.
    expect(
      stripSourceComments(`  // if (v.status !== 'visible') return;\nconst a = 1;\n`)
    ).not.toContain(`status !== 'visible'`);
    expect(stripSourceComments(`const a = 1; // ${SYMBOL}(row, level);\n`)).not.toContain(
      `${SYMBOL}(`
    );
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
