import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * SEAM GUARD — the `classifyGatedImageForViewer` CALL-SITE LEDGER.
 *
 * The verdict gained a third state (`pending` — nothing has rated this image
 * yet). Every consumer that is not the grid projection must keep treating
 * anything other than `visible` as a refusal, and it must do so by spelling the
 * test `!== 'visible'`: a gate written `=== 'hidden'` was correct while the union
 * had two members and silently ADMITS a `pending` image now. That is not a bug in
 * either file on its own — each one type-checks, each one's unit tests pass — so
 * it is exactly the class of defect a per-file suite cannot see.
 *
 * This asserts the RELATIONSHIP, not a component:
 *   1. the exact SET of call sites (fails when it GROWS *or* SHRINKS, so a new
 *      consumer cannot join without a human deciding what it does with `pending`),
 *   2. that no call site outside the projection gates on `=== 'hidden'`.
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

describe(`${SYMBOL} seam`, () => {
  // POSITIVE CONTROL for the scanner itself: if this walk could not see the
  // definition module, a ZERO call-site count below would be a fact about the
  // walk, not about the codebase.
  it('the file walk actually reaches the module under test', () => {
    const rels = PRODUCTION_FILES.map((f) => relative(SRC, f));
    expect(rels).toContain(DEFINITION);
    expect(PRODUCTION_FILES.length).toBeGreaterThan(500);
  });

  it('has exactly the ledgered call sites — no more, no fewer', () => {
    const found = PRODUCTION_FILES.filter((f) => {
      const rel = relative(SRC, f);
      if (rel === DEFINITION) return false;
      return readFileSync(f, 'utf8').includes(`${SYMBOL}(`);
    })
      .map((f) => relative(SRC, f))
      .sort();

    expect(found).toEqual(EXPECTED_CALL_SITES);
  });

  it("no consumer gates on `=== 'hidden'` — a `pending` image would walk past it", () => {
    for (const rel of EXPECTED_CALL_SITES) {
      if (MAY_BRANCH_ON_HIDDEN.has(rel)) continue;
      const source = readFileSync(join(SRC, rel), 'utf8');
      // Strip comments so the prose ABOVE the gate (which names the wrong
      // spelling in order to forbid it) cannot satisfy or trip this check.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(code).not.toContain(`status === 'hidden'`);
      expect(code).toContain(`status !== 'visible'`);
    }
  });
});
