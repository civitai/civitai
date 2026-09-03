import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE FULL-BLEED LEDGER MUST SURVIVE THE PRODUCTION COMPILER'S ATTRIBUTE STRIP.
 *
 * This is a SEAM guard. Two files were each correct on their own and broken
 * together, and every existing test was scoped to one side of the seam:
 *
 *   · `next.config.mjs` strips `data-testid` from the DOM in production builds
 *     (`compiler.reactRemoveProperties`, gated on `NODE_ENV === 'production'`).
 *   · `src/styles/globals.css` keyed the opt-out ledger on
 *     `[data-testid='app-page-frame'][data-block-id='…']`.
 *
 * So on the live site the compound selector matched ZERO elements, and
 * `playable-collections` — an app whose every open-collection view mode is
 * uncapped by the app itself — rendered letterboxed at the 1600px cap, the exact
 * outcome the rule's own comment says it exists to prevent. Measured on
 * civitai.com/apps/run/playable-collections (image `20260902233645-bbbe837`):
 * the rule was present in the deployed CSS verbatim; 0 elements matched the
 * compound selector; 1 matched `[data-block-id='playable-collections']`; the
 * whole page carried 0 `data-testid` attributes across 615 elements while 209
 * elements carried other `data-*` attributes; the computed
 * `--app-page-max-width` on the capped box was `1600px`.
 *
 * 🔴 WHY NO TEST COULD SEE IT, AND WHY THIS ONE CAN. Every tier runs with
 * `NODE_ENV !== 'production'`, so the testid is present and the selector matches
 * — including `PageBlockHostMaxWidth.browser.test.tsx`, which INJECTS a rule of
 * that exact shape and measures full-bleed at 2560x1080. That suite is not
 * wrong; it is structurally blind, because its environment fixes the one
 * dimension the defect lives on. A rendered test can never see this. The only
 * thing that can is a check that reads the two CONFIGURATIONS and compares them,
 * which is what this file does — it restates neither side.
 *
 * WHAT IS PINNED HERE:
 *   · the strip list is parseable out of `next.config.mjs`, non-empty, and
 *     production-gated (the reason the other tiers cannot see it)
 *   · at least one ledger rule is parseable out of `globals.css`
 *   · NO attribute any ledger selector depends on is removed by that strip list
 *     — checked over the shipped rules AND over the ledger's own "HOW TO ADD ONE"
 *     template, because a doc example teaching the broken spelling re-creates the
 *     bug on the next entry
 *   · every attribute a ledger selector depends on is actually STAMPED by
 *     `PageBlockHost.tsx` — surviving the strip is worthless if nothing renders it
 *
 * FAILS CLOSED. An unparseable config, an empty strip list, or zero parsed ledger
 * rules is a FAILURE, not a quiet pass: a reassuring zero here is indistinguishable
 * from a guard wired to nothing. If `reactRemoveProperties` is ever removed
 * deliberately, delete or re-point this file in the same commit rather than
 * letting it fail — but do that knowingly.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NEXT_CONFIG = path.join(REPO_ROOT, 'next.config.mjs');
const GLOBALS_CSS = path.join(REPO_ROOT, 'src/styles/globals.css');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');

const repoPath = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

function read(file: string): string {
  // Prove the path before trusting anything derived from it — a comparison
  // against an absent operand reports SAME, not MISSING, so a renamed file would
  // turn every assertion below into a vacuous pass on an empty string.
  expect(fs.existsSync(file), `${repoPath(file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip `/* *\/` block comments and `//` line comments. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The property-name patterns `reactRemoveProperties` deletes in a production
 * build, read out of `next.config.mjs`.
 *
 * Deliberately a narrow regex over the source rather than importing the config:
 * `next.config.mjs` pulls in the whole Next build pipeline as a side effect, and
 * the value we need is a literal array two tokens from a fixed key.
 */
function stripPatterns(): string[] {
  const cfg = read(NEXT_CONFIG);
  const m = /reactRemoveProperties\s*:\s*\{\s*properties\s*:\s*\[([^\]]*)\]/.exec(cfg);
  expect(
    m,
    'could not parse `compiler.reactRemoveProperties.properties` out of next.config.mjs. This ' +
      'guard exists to compare that strip list against the full-bleed opt-out ledger in ' +
      'globals.css; with the list unreadable it can prove nothing, so it fails rather than ' +
      'passing silently. If `reactRemoveProperties` was removed on purpose, delete or re-point ' +
      'this file in the same commit.'
  ).not.toBeNull();

  const patterns = [...(m as RegExpExecArray)[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((p) => p[1]);
  expect(
    patterns,
    'next.config.mjs declares `reactRemoveProperties` with an EMPTY property list. Either the ' +
      'literals moved behind a variable this parse cannot follow (then fix the parse), or the ' +
      'strip was disabled (then this guard is obsolete). An empty list would let every ledger ' +
      'selector pass unchecked, which is the reassuring-zero failure this file is about.'
  ).not.toHaveLength(0);
  return patterns;
}

/** A run of consecutive attribute selectors that includes `[data-block-id=…]`. */
type LedgerSelector = { text: string; attrs: string[] };

/**
 * Every ledger-shaped attribute-selector run in `css`, with the attribute names
 * it depends on.
 *
 * A "run" is one or more adjacent `[…]` selectors — the compound shape the ledger
 * uses. Runs that do not name `data-block-id` are not ledger rules and are
 * skipped, which is what keeps unrelated rules like `#__next:has([data-adhesive-ad])`
 * out of this guard's scope.
 */
function ledgerSelectors(css: string): LedgerSelector[] {
  const RUN = /(?:\[\s*[A-Za-z_][\w-]*(?:\s*[~|^$*]?=\s*(?:'[^']*'|"[^"]*"|[^\]\s]+))?\s*\]\s*)+/g;
  const out: LedgerSelector[] = [];
  for (const m of css.matchAll(RUN)) {
    const text = m[0].trim();
    if (!/\[\s*data-block-id\s*[~|^$*]?=/.test(text)) continue;
    out.push({
      text,
      attrs: [...text.matchAll(/\[\s*([A-Za-z_][\w-]*)/g)].map((a) => a[1]),
    });
  }
  return out;
}

/**
 * Which attributes of `selector` production removes, given `patterns`.
 * The unit under test — exercised against a synthetic known-bad input below so
 * this file is never a check that has only ever been watched to pass.
 */
function strippedAttrsIn(selector: LedgerSelector, patterns: string[]): string[] {
  return selector.attrs.filter((attr) => patterns.some((p) => new RegExp(p).test(attr)));
}

describe('the full-bleed opt-out ledger survives the production attribute strip', () => {
  it('the strip list is parseable, non-empty, and gated on a production build', () => {
    const patterns = stripPatterns();
    expect(patterns.length).toBeGreaterThan(0);

    // The production gate is WHY every other tier is blind to this, so it is
    // part of the claim rather than background. If the strip ever became
    // unconditional, the browser suite would start failing on its own and this
    // guard's framing would need rewriting.
    const cfg = read(NEXT_CONFIG);
    const gate = cfg.slice(0, cfg.indexOf('reactRemoveProperties'));
    expect(
      gate,
      'the `reactRemoveProperties` strip in next.config.mjs is no longer preceded by a ' +
        "`NODE_ENV === 'production'` gate. This guard's whole premise is that the strip happens " +
        'ONLY in production, which is why no rendered test tier can observe it. Re-read the ' +
        'config before trusting anything else in this file.'
    ).toContain("process.env.NODE_ENV === 'production'");
  });

  /**
   * 🔴 NEGATIVE CONTROL — can this check go red at all?
   *
   * The known-bad attribute is DERIVED from the parsed patterns (anchors stripped
   * off a literal pattern), not restated as `data-testid`, so the control moves
   * with the config instead of pinning today's value. A check that has only ever
   * been watched to pass is a claim about the check.
   */
  it('CONTROL — a ledger selector using a stripped attribute is reported as a violation', () => {
    const patterns = stripPatterns();
    // Pair the derived name with the pattern it came from — filtering first and
    // indexing back into `patterns` would misalign the moment one is dropped.
    const samples = patterns
      .map((p) => ({ pattern: p, name: p.replace(/^\^/, '').replace(/\$$/, '') }))
      .filter(
        ({ pattern, name }) => /^[A-Za-z_][\w-]*$/.test(name) && new RegExp(pattern).test(name)
      )
      .map(({ name }) => name);
    expect(
      samples,
      'no literal attribute name could be derived from the parsed strip patterns, so this ' +
        'control cannot build a known-bad input and the checks below have no negative control. ' +
        'Add a derivation for the new pattern shape rather than deleting this test.'
    ).not.toHaveLength(0);

    const bad = ledgerSelectors(`[${samples[0]}='app-page-frame'][data-block-id='x'] { }`);
    expect(
      bad,
      'the ledger-selector extraction did not even match a synthetic ledger rule'
    ).toHaveLength(1);
    expect(
      strippedAttrsIn(bad[0], patterns),
      'the strip check did NOT flag a selector built from an attribute the production compiler ' +
        'is configured to remove. The check is inert — fix it before reading any verdict below.'
    ).toEqual([samples[0]]);

    // …and green on the shape the ledger is supposed to use.
    const good = ledgerSelectors(`[data-app-page-frame][data-block-id='x'] { }`);
    expect(good).toHaveLength(1);
    expect(strippedAttrsIn(good[0], patterns)).toEqual([]);
  });

  it('🔴 no shipped ledger rule depends on an attribute production strips', () => {
    const patterns = stripPatterns();
    const shipped = ledgerSelectors(stripComments(read(GLOBALS_CSS)));

    // Minimum parsed-rule count. Zero would make every assertion below vacuous,
    // and a broken regex reads exactly like "nothing to check".
    expect(
      shipped.length,
      'zero `[data-block-id=…]` ledger rules were parsed out of src/styles/globals.css. Either ' +
        'the full-bleed ledger was emptied (then this guard and the membership expectation in ' +
        '__tests__/pageBlockHostMaxWidth.test.ts should be retired together, deliberately), or ' +
        'this parse no longer reaches the rules. Failing rather than passing on zero is the point.'
    ).toBeGreaterThanOrEqual(1);

    const violations = shipped
      .map((s) => ({ selector: s.text, stripped: strippedAttrsIn(s, patterns) }))
      .filter((v) => v.stripped.length > 0);

    expect(
      violations,
      'a full-bleed ledger rule in src/styles/globals.css is keyed on an attribute that ' +
        '`next.config.mjs` REMOVES from the production DOM ' +
        `(${patterns.join(', ')}). The rule ships in the stylesheet and matches nothing on the ` +
        'live site, so the app it excuses from the ultrawide cap is letterboxed in production ' +
        'while every test tier passes — they all run with NODE_ENV != production, where the ' +
        'attribute still exists. Key the rule on a marker the compiler keeps, such as ' +
        '`data-app-page-frame`, which PageBlockHost stamps beside `data-block-id`.'
    ).toEqual([]);
  });

  /**
   * The ledger's own worked example is the thing the next person copies. If it
   * teaches the stripped spelling, the next entry re-creates the production-only
   * defect — so the template is held to the same rule as the rules.
   */
  it('🔴 the ledger’s HOW-TO-ADD-ONE template teaches a spelling that survives production', () => {
    const patterns = stripPatterns();
    const raw = read(GLOBALS_CSS);
    const documented = ledgerSelectors(raw);
    expect(
      documented.length,
      'no ledger-shaped selector was found in src/styles/globals.css at all, comments included ' +
        '— the template and the rules both went missing, or this parse is broken.'
    ).toBeGreaterThanOrEqual(1);

    const bad = documented
      .map((s) => ({ selector: s.text, stripped: strippedAttrsIn(s, patterns) }))
      .filter((v) => v.stripped.length > 0);

    expect(
      bad,
      'the full-bleed ledger documentation in src/styles/globals.css shows a selector keyed on ' +
        'an attribute production strips. Even if no shipped rule uses that shape today, the ' +
        'example is what the next entry is copied from, so it reproduces the defect one commit ' +
        'later. Update the "HOW TO ADD ONE" template as well as the rules.'
    ).toEqual([]);
  });

  /**
   * Surviving the strip is only half of it: a ledger keyed on an attribute nobody
   * renders matches nothing for a different reason, and looks just as fine.
   */
  it('🔴 every attribute the ledger depends on is actually stamped by PageBlockHost', () => {
    const host = stripComments(read(HOST));
    const shipped = ledgerSelectors(stripComments(read(GLOBALS_CSS)));
    expect(
      shipped.length,
      'zero ledger rules parsed — see the strip test above'
    ).toBeGreaterThanOrEqual(1);

    const attrs = [...new Set(shipped.flatMap((s) => s.attrs))].sort();
    const unstamped = attrs.filter((a) => !host.includes(`${a}=`));

    expect(
      unstamped,
      'a full-bleed ledger rule in src/styles/globals.css selects on an attribute that ' +
        'PageBlockHost.tsx does not stamp on its root, so the rule matches nothing — the same ' +
        'silent outcome as keying it on a stripped attribute, arrived at from the other side. ' +
        'Either restore the attribute on the host root or re-key the ledger onto one that is ' +
        'really rendered.'
    ).toEqual([]);
  });
});
