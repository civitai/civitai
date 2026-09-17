import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
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

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const PRODUCTION_FILES = walk(SRC).filter((f) => {
  const rel = relative(SRC, f);
  return !rel.includes('__tests__') && !/\.test\.tsx?$/.test(rel) && !rel.includes('/tests/');
});

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
const SOURCE = new Map<string, string>();
for (const full of PRODUCTION_FILES) {
  const raw = readFileSync(full, 'utf8');
  if (!raw.includes('block-gated-images.logic') && !raw.includes(SYMBOL)) continue;
  SOURCE.set(relative(SRC, full), stripSourceComments(raw));
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

describe(`${SYMBOL} seam`, () => {
  // POSITIVE CONTROL for the scanner itself: if this walk could not see the
  // definition module, a ZERO call-site count below would be a fact about the
  // walk, not about the codebase.
  it('the file walk actually reaches the module under test', () => {
    const rels = [...SOURCE.keys()];
    expect(rels).toContain(DEFINITION);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(500);
  });

  // POSITIVE CONTROL for the DETECTOR, not just the walk. A ledger assertion that
  // has never been watched match anything is indistinguishable from one wired to
  // nothing — and the defect this rewrite fixes was exactly a detector that
  // returned a confident, wrong `false`. These feed the real predicate the
  // synthetic sources an aliased consumer would have, and require it to say YES.
  it('the detector matches an ALIASED import (the shape that walked the old ledger)', () => {
    const aliased = `import { ${SYMBOL} as classify } from '~/server/services/blocks/block-gated-images.logic';\nif (classify(row, level).status === 'hidden') {}\n`;
    expect(LOGIC_MODULE_IMPORT.test(aliased)).toBe(true);
    // …and the OLD spelled-only rule does NOT — i.e. this control can tell the
    // two detectors apart, so a green here is about the new rule.
    expect(aliased.includes(`${SYMBOL}(`)).toBe(false);

    // The other spellings a consumer can be written in.
    for (const source of [
      `import { ${SYMBOL} } from '~/server/services/blocks/block-gated-images.logic';`,
      `import { ${SYMBOL} as c } from './block-gated-images.logic';`,
      `import * as gate from '../blocks/block-gated-images.logic';`,
      `export { ${SYMBOL} } from '~/server/services/blocks/block-gated-images.logic';`,
    ]) {
      expect(LOGIC_MODULE_IMPORT.test(source), source).toBe(true);
    }

    // NEGATIVE control: prose naming the module is not an import. (Real sources
    // are comment-stripped before the predicate runs; this pins the regex itself.)
    expect(LOGIC_MODULE_IMPORT.test('see block-gated-images.logic.ts for the clamp')).toBe(false);
  });

  it('has exactly the ledgered call sites — no more, no fewer', () => {
    const found = [...SOURCE.keys()].filter(isCallSite).sort();
    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it("no consumer gates on `=== 'hidden'` — a `pending` image would walk past it", () => {
    for (const rel of EXPECTED_CALL_SITES) {
      if (MAY_BRANCH_ON_HIDDEN.has(rel)) continue;
      // Comments are already stripped, so the prose ABOVE the gate (which names
      // the wrong spelling in order to forbid it) cannot satisfy or trip this.
      const code = SOURCE.get(rel) ?? '';
      expect(code).not.toContain(`status === 'hidden'`);
      expect(code).toContain(`status !== 'visible'`);
    }
  });
});
