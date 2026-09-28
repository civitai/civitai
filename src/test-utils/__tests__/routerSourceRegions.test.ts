import { describe, expect, it } from 'vitest';
import {
  blankComments,
  callSites,
  declRegions,
  enclosingDecl,
  MONEY_MARKERS,
  moneyIdentifiersIn,
  moneyMarkersIn,
  sourceDecls,
  structuralQuoteRole,
  topLevelPropertyText,
} from '../routerSourceRegions';

/**
 * DIRECT COVERAGE FOR THE SHARED GUARD PRIMITIVES.
 *
 * 🔴 WHY THIS FILE EXISTS. These functions are the discriminator two MONEY
 * guards classify router paths with — `no-divergent-author-fee-base.test.ts` and
 * `no-direct-block-budget-claim-read.test.ts` — and until now they were exercised
 * only THROUGH those guards, against one real 11,000-line file. That is the
 * "verified in isolation" problem inverted: the consumers were tested and the
 * instrument was not, so a stripper defect could only ever surface as a confusing
 * result in a guard, and a stripper defect that makes a guard quietly PASS could
 * not surface at all.
 *
 * Both consumers already assert positive controls over the real router. What they
 * cannot do is feed the stripper the adversarial inputs below, because the real
 * router does not contain them — which is exactly why the defects survived.
 */
describe('blankComments', () => {
  it('blanks a line comment and preserves byte offsets', () => {
    // Offset preservation is the property `enclosingDecl`/`declRegions` depend on:
    // they index the blanked text with offsets and slice the result, so a stripper
    // that shortened the source would mis-attribute every call site.
    const src = 'const a = 1; // await chargeBlockAuthorFee({\nconst b = 2;';
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).not.toContain('chargeBlockAuthorFee(');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('blanks a block comment across lines, keeping the newlines', () => {
    const src = 'const a = 1;\n/* await chargeBlockAuthorFee({\n   more prose */\nconst b = 2;';
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(4);
    expect(out).not.toContain('chargeBlockAuthorFee(');
    expect(out).toContain('const b = 2;');
  });

  it('does NOT treat `//` inside a string literal as a comment', () => {
    const src = "const url = 'https://example.com/x';\nawait chargeBlockAuthorFee({ a: 1 });";
    expect(blankComments(src)).toContain('chargeBlockAuthorFee({');
  });

  it('does NOT treat an escaped slash in a regex literal as a comment', () => {
    // The fail-OPEN case the module's docblock names: a backslash consumes the
    // next character in every context, so `\/\/` is not a line comment.
    const src = 'const re = /a\\/\\//;\nawait chargeBlockAuthorFee({ a: 1 });';
    expect(blankComments(src)).toContain('chargeBlockAuthorFee({');
  });

  it('🔴 a quote inside a REGEX CHARACTER CLASS does not swallow the rest of the file', () => {
    // 🔴 THE MEASURED DEFECT. `/['"]/` is not a string opener, but the walk does
    // not lex regex literals — so before the newline bound, the `'` started a
    // scan that ran to the next `'` ANYWHERE in the file. Everything between was
    // skipped, and when the walk resumed inside a real string containing `//`
    // (a URL) it blanked live code as a comment. That is fail-OPEN: a guard
    // looking for a money call in that span finds nothing and reports green.
    //
    // ⚠️ THE MONEY CALL MUST SHARE A LINE WITH THE URL, AND THE FIRST VERSION OF
    // THIS TEST DID NOT — SO IT PASSED EITHER WAY. Unbounded, the runaway scan
    // ends at the URL string's OPENING quote, the walk resumes inside the URL,
    // and `//example.com…` is then eaten as a line comment. That damage stops at
    // the newline, so code on the NEXT line survives and the test proved nothing.
    // Mutation-checked: removing the bound must make this red.
    const src = [
      'const q = /[\'"]/;',
      "const url = 'https://x'; await chargeBlockAuthorFee({ a: 1 });",
    ].join('\n');
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(
      out,
      'real code was blanked away — a money guard over this span would read as clean'
    ).toContain('chargeBlockAuthorFee({');
  });

  it('a template literal MAY still span lines', () => {
    // The bound is on `'` and `"` only. A backtick legitimately spans lines, and
    // narrowing it would blank real code inside multi-line templates.
    const src = 'const t = `line one\nline // two`;\nawait chargeBlockAuthorFee({ a: 1 });';
    const out = blankComments(src);
    expect(out).toContain('line // two');
    expect(out).toContain('chargeBlockAuthorFee({');
  });
});

describe('sourceDecls / enclosingDecl / declRegions', () => {
  const src = [
    'async function alpha(a: number) {',
    '  return a;',
    '}',
    'async function beta(b: number) {',
    '  await chargeBlockAuthorFee({ b });',
    '}',
  ].join('\n');

  it('finds module-level async functions in file order', () => {
    expect(sourceDecls(src).map((d) => d.name)).toEqual(['alpha', 'beta']);
  });

  it('recognises ANY `*Procedure` spelling, not just public/protected', () => {
    // The widening that mattered: a router also declares `moderatorProcedure` and
    // `appDeveloperProcedure` handlers, and skipping them resolved an offset
    // inside one to the PREVIOUS known procedure — silently attributing a call
    // site to a path it is not in.
    const router = [
      'export const r = router({',
      '  one: publicProcedure.query(() => 1),',
      '  two: moderatorProcedure.query(() => 2),',
      '  three: appDeveloperProcedure.query(() => 3),',
      '});',
    ].join('\n');
    expect(sourceDecls(router).map((d) => d.name)).toEqual(['one', 'two', 'three']);
  });

  it('attributes an offset to its enclosing declaration', () => {
    expect(enclosingDecl(src, src.indexOf('chargeBlockAuthorFee'))).toBe('beta');
    expect(enclosingDecl(src, src.indexOf('return a;'))).toBe('alpha');
    expect(enclosingDecl(src, 0)).toBe('<module scope>');
  });

  it('slices one region per declaration, each ending at the next', () => {
    const regions = declRegions(src);
    expect([...regions.keys()]).toEqual(['alpha', 'beta']);
    expect(regions.get('alpha')).not.toContain('chargeBlockAuthorFee');
    expect(regions.get('beta')).toContain('chargeBlockAuthorFee');
  });
});

describe('money classification', () => {
  it('moneyMarkersIn reports exactly the primitives present', () => {
    expect(moneyMarkersIn('await reserveAppSpend(x); await chargeBlockAuthorFee({});')).toEqual([
      'chargeBlockAuthorFee(',
      'reserveAppSpend(',
    ]);
    expect(moneyMarkersIn('const a = 1;')).toEqual([]);
  });

  it('🔴 ANY money primitive makes a region RESERVING — not all of them', () => {
    // 🔴 THE RULE THAT LET A FIFTH PRIMITIVE THROUGH. This was
    // `found === MONEY_MARKERS.length`, which capped the marker list at the
    // INTERSECTION of the reserving paths (measured on the real router: one calls
    // 7 of the 15, another 9). A list that cannot be completed is a list a mutant
    // walks around, and one did — twice.
    expect(structuralQuoteRole('await reserveBlockBuzzSpend(userId, 999);')).toBe('reserving');
    expect(structuralQuoteRole('await chargeBlockAuthorFee({});')).toBe('reserving');
    expect(MONEY_MARKERS.length).toBeGreaterThan(2);
  });

  it('🔴 a region touching NO money primitive DISCLOSES — the strong half', () => {
    expect(structuralQuoteRole('const shown = quoted + fee; return { shown };')).toBe('disclosing');
  });

  it('moneyIdentifiersIn enumerates by naming shape, deduped and sorted', () => {
    const src =
      'await reserveAppSpend(a); await reserveAppSpend(b); await chargeDevSessionOverage(c);' +
      ' await refundAppSpend(d); notMoney(e); reserveme(f);';
    // `notMoney` lacks the verb prefix; `reserveme` lacks the capital, so neither
    // is a money identifier — the pattern is a CONVENTION and this pins its edges.
    expect(moneyIdentifiersIn(src)).toEqual([
      'chargeDevSessionOverage',
      'refundAppSpend',
      'reserveAppSpend',
    ]);
  });

  it('every MONEY_MARKER is itself a well-formed money identifier', () => {
    // Keeps the hand-written list and the derived pattern from drifting apart: a
    // marker the pattern could never produce would be unreachable by the
    // completeness guard that compares the two.
    for (const marker of MONEY_MARKERS) {
      expect(
        moneyIdentifiersIn(`await ${marker})`),
        `${marker} is not matched by the pattern`
      ).toEqual([marker.slice(0, -1)]);
    }
  });
});

/**
 * `callSites` + `topLevelPropertyText` — THE BRACE WALK, EXERCISED DIRECTLY.
 *
 * 🔴 THIS BLOCK EXISTS BECAUSE A MUTATION SWEEP FOUND THE WALK UNCOVERED, AND THE
 * WAY IT FOUND IT IS THE POINT. Breaking `callSites` so it stops at the FIRST `}`
 * instead of the matching one — destroying the entire reason the function walks
 * braces at all — left **both** consuming money ledgers green across 46 tests.
 *
 * The cause is corpus shape, not a weak assertion: 6 of the 10 governed argument
 * objects in the router are flat, and in the 2 nested ones the nested object closes
 * AFTER the field the ledgers look for, so a truncated slice happened to still
 * contain it. The walk's whole purpose was therefore unexercised by either
 * consumer, and would have stayed that way until someone added a call site whose
 * nested object came first — at which point the guard silently under-counts.
 *
 * A guard over a real corpus cannot be relied on to exercise its own instrument:
 * it covers the shapes that corpus happens to contain. These fixtures are
 * synthetic on purpose, and they contain the shapes the router currently does not.
 */
describe('callSites — brace-matched extraction', () => {
  it('🔴 does not end a slice at a NESTED closing brace', () => {
    // The case a break-on-first-`}` mutant gets wrong, and which no real call site
    // currently expresses: the nested object closes BEFORE the trailing field.
    const src = 'fn({ a: 1, nested: { b: 2 }, tail: 3 });';
    const [site] = callSites(src, 'fn({');
    expect(site).toBe('fn({ a: 1, nested: { b: 2 }, tail: 3 }');
    expect(site, 'the slice must reach past the nested close').toContain('tail: 3');
  });

  it('handles several levels of nesting', () => {
    const src = 'fn({ a: { b: { c: 1 } }, tail: 2 });';
    expect(callSites(src, 'fn({')[0]).toContain('tail: 2');
  });

  it('finds every occurrence, and does not re-find inside a slice it already took', () => {
    const src = 'fn({ a: 1 }); fn({ b: { c: 2 } }); fn({ d: 3 });';
    const sites = callSites(src, 'fn({');
    expect(sites).toHaveLength(3);
    expect(sites[1]).toContain('c: 2');
  });

  it('returns [] for an opener that does not occur — the vacuous-green trap', () => {
    // Documented rather than merely true: every consumer must assert a positive
    // control, because `[].every(…)` is `true` and a misspelled opener would make a
    // whole guard pass while covering nothing.
    expect(callSites('fn({ a: 1 });', 'nope({')).toEqual([]);
  });
});

describe('topLevelPropertyText — depth filtering', () => {
  const site = callSites('fn({ a: 1, opts: build({ hidden: true }), tail: 2 });', 'fn({')[0];

  it('🔴 a field nested inside another call does NOT count as present', () => {
    // The walk-past shape: the field is in the slice, but not on the argument
    // object. A guard greping the raw slice is satisfied; this must not be.
    expect(site, 'the raw slice does contain it').toContain('hidden: true');
    expect(topLevelPropertyText(site)).not.toContain('hidden: true');
  });

  it('keeps the argument object own properties', () => {
    const text = topLevelPropertyText(site);
    expect(text).toContain('a: 1');
    expect(text).toContain('tail: 2');
    expect(text).toContain('opts:');
  });

  it('preserves length and newlines so offsets still line up', () => {
    const multi = callSites('fn({\n  a: 1,\n  o: g({\n    z: 9,\n  }),\n});', 'fn({')[0];
    const text = topLevelPropertyText(multi);
    expect(text).toHaveLength(multi.length);
    expect(text.split('\n')).toHaveLength(multi.split('\n').length);
    expect(text).not.toContain('z: 9');
  });

  it('blanks a nested ARRAY and a nested plain object, not just a nested call', () => {
    const arr = callSites('fn({ a: [ { q: 1 } ], b: { r: 2 }, c: 3 });', 'fn({')[0];
    const text = topLevelPropertyText(arr);
    expect(text).not.toContain('q: 1');
    expect(text).not.toContain('r: 2');
    expect(text).toContain('c: 3');
  });

  it('🔴 tracks PARENS, not only braces — a nested call with no braces still blanks', () => {
    // Without `(` in the increment set every other fixture here still passes, because
    // each nested span also opens a `{`. This is the one that isolates the paren.
    const s = callSites("fn({ a: 1, note: label('hidden: yes'), tail: 2 });", 'fn({')[0];
    expect(s).toContain('hidden: yes');
    expect(topLevelPropertyText(s)).not.toContain('hidden: yes');
    expect(topLevelPropertyText(s)).toContain('tail: 2');
  });

  it('🔴 tracks BRACKETS, not only braces — an array of primitives still blanks', () => {
    // Same isolation for `[`: the existing array fixture nests an object inside, so
    // `{` alone would carry it.
    const s = callSites("fn({ a: 1, list: ['hidden: yes'], tail: 2 });", 'fn({')[0];
    expect(s).toContain('hidden: yes');
    expect(topLevelPropertyText(s)).not.toContain('hidden: yes');
    expect(topLevelPropertyText(s)).toContain('tail: 2');
  });

  it('returns empty for a slice with no object at all', () => {
    expect(topLevelPropertyText('fn(')).toBe('');
  });
});
