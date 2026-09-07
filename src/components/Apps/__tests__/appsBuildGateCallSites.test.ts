import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 THE CALL-SITE LEDGER for the `/apps/build` gate — the structural half of what
 * `appsBuildAccess.test.ts` covers behaviourally.
 *
 * WHY BOTH. `appsBuildAccess.test.ts` proves the tab predicate and the page resolver
 * agree, but it does that by calling `canAccessAppsBuild` and `resolveBuildPageAccess`
 * DIRECTLY. It would go on passing if `SUB_NAV_LINKS`'s Build row quietly stopped calling
 * the shared predicate and open-coded `c.isAuthor` instead — the row is module-private,
 * so no test in the unit project renders it. That is precisely the mutant the sibling
 * ledger for `hasAppsStoreAccess` was written after an audit proved SURVIVES a fully
 * green suite (see `appsStoreAccessCallSites.test.ts`'s header: six sites converted, four
 * reverted, 114/114 still green).
 *
 * So this asserts the RELATIONSHIP: the exact set of modules that decide `/apps/build`
 * access, that each routes through the shared predicate, and that none of them re-inlines
 * its terms. It fails when the set GROWS (a third gate nobody decided about) and when it
 * SHRINKS (a site reverted to open-coding).
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. This proves each site CALLS the
 * predicate; it cannot prove the call was passed the right arguments, and it would
 * type-check past `canAccessAppsBuild(someOtherUser, someOtherFlags)`. That half is
 * covered by `appsBuildAccess.test.ts` (the resolver) and
 * `AppsSubNav.storeGate.browser.test.tsx` (the rendered bar). Stated rather than implied.
 */

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every module that decides who reaches `/apps/build`. TWO, and it must stay two — the
 * whole point of the consolidation is that there is one rule with one implementation.
 */
const BUILD_GATE_SITES = [
  'components/Apps/AppsSubNav.tsx',
  'components/Apps/resolveBuildPageAccess.ts',
] as const;

/** The ONE module allowed to spell the rule out — it defines it. */
const DEFINING_MODULE = 'shared/utils/app-blocks-access.ts';

/** Directories scanned for a re-inlined gate. The definition lives outside them. */
const SCAN_ROOTS = ['components/Apps', 'pages/apps'];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * Blank comment and string contents so a scan sees LIVE CODE only.
 *
 * 🔴 THIS FILE'S PROSE IS FULL OF THE VERY EXPRESSION IT SEARCHES FOR — the header above
 * writes `c.isAuthor`, and both gate sites discuss `appBlocksGetStarted` at length in
 * their doc comments. An unmasked scan reports the files that are CORRECT. Deliberately a
 * simple lexer rather than the TS parser used by `appsStoreAccessCallSites.test.ts`: that
 * one has to survive JSX apostrophes across a 20k-char page, this one runs over two files
 * whose only risk is a doc comment, and the positive control below is what proves it is
 * not blanking real code. If this ever needs to scan a JSX-heavy file, take the parser.
 */
function stripNonCode(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
}

function flatten(code: string): string {
  return code.replace(/\s+/g, ' ');
}

/**
 * An open-coded `/apps/build` gate in LIVE code: the get-started flag joined by a logical
 * operator to an author or store term inside one expression. Matched on PROXIMITY rather
 * than one literal shape, so a prettier line-wrap, a De Morgan negation or a `??` chain
 * cannot walk past it — the four evasions the sibling ledger measured against its own
 * first single-line regex.
 *
 * `\b` after `appBlocks` matters: without it `appBlocksAuthor` and `appBlocksGetStarted`
 * would each read as `appBlocks` and this would fire on correct code.
 *
 * 🔴 THE GAP CLASS IS `[^;]`, NOT `[^;{}]`, AND THAT IS A MEASURED CORRECTION RATHER THAN
 * A LOOSENING. The sibling ledger for the store gate excludes braces to keep a match
 * inside one expression — correct there, wrong here, because the real rule contains an
 * OBJECT LITERAL: `isAppDeveloper(user, { appBlocksAuthor: … }) || features.appBlocksGetStarted`.
 * With braces excluded, the pattern could not match the very expression it exists to find,
 * so the DEFINING_MODULE control below went red on correct code — which is the good
 * outcome, because the same blindness would have scored a real re-inline as clean. The
 * length bound plus `;` is what still keeps a match from spanning statements.
 */
const INLINED_BUILD_GATE = new RegExp(
  [
    `appBlocksGetStarted\\b[^;]{0,200}?(?:\\|\\||&&|\\?\\?)[^;]{0,200}?(?:isAppDeveloper|appBlocksAuthor|hasAppsStoreAccess|appListings)\\b`,
    `(?:isAppDeveloper|appBlocksAuthor|hasAppsStoreAccess|appListings)\\b[^;]{0,200}?(?:\\|\\||&&|\\?\\?)[^;]{0,200}?appBlocksGetStarted\\b`,
  ].join('|')
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SCANNED = SCAN_ROOTS.flatMap((root) => walk(path.join(SRC, root))).map((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  return {
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    raw,
    code: stripNonCode(raw),
  };
});

describe('the masker and the pattern (validate the instrument before reading its verdict)', () => {
  it('🔴 POSITIVE CONTROL: the pattern matches a real re-inlined gate', () => {
    // If this stops matching, every zero below is a fact about the regex.
    expect(
      flatten(
        stripNonCode('const ok = hasAppsStoreAccess(f) && (a || features.appBlocksGetStarted);')
      )
    ).toMatch(INLINED_BUILD_GATE);
    expect(
      flatten(stripNonCode('if (!features.appBlocksGetStarted && !isAppDeveloper(u)) return null;'))
    ).toMatch(INLINED_BUILD_GATE);
    expect(
      flatten(
        stripNonCode('const ok =\n  features.appBlocksAuthor ||\n  features.appBlocksGetStarted;')
      )
    ).toMatch(INLINED_BUILD_GATE);
  });

  it('blanks a gate written in a comment or a string', () => {
    expect(
      flatten(stripNonCode('// hasAppsStoreAccess(f) && (a || features.appBlocksGetStarted)'))
    ).not.toMatch(INLINED_BUILD_GATE);
    expect(
      flatten(stripNonCode('/* isAppDeveloper(u) || features.appBlocksGetStarted */'))
    ).not.toMatch(INLINED_BUILD_GATE);
    expect(
      flatten(stripNonCode("const s = 'isAppDeveloper(u) || features.appBlocksGetStarted';"))
    ).not.toMatch(INLINED_BUILD_GATE);
  });

  it('🔴 does NOT read appBlocksGetStarted / appBlocksAuthor as the store flag appBlocks', () => {
    // The prefix collision. Without `\b` this would fire on any file mentioning both
    // capability flags, i.e. on the two correct gate sites.
    expect(
      flatten(stripNonCode('const x = features.appBlocks || features.appListings;'))
    ).not.toMatch(INLINED_BUILD_GATE);
  });

  it('a lone mention of the flag is not a gate', () => {
    expect(flatten(stripNonCode('const g = !!features.appBlocksGetStarted;'))).not.toMatch(
      INLINED_BUILD_GATE
    );
  });

  it('the walk reached a plausible number of modules, and both ledger sites', () => {
    // A zero is indistinguishable from a walk wired to nothing. Floor well below the live
    // count so retiring a file does not red the guard.
    expect(SCANNED.length).toBeGreaterThanOrEqual(40);
    const seen = new Set(SCANNED.map((f) => f.rel));
    expect(BUILD_GATE_SITES.filter((s) => !seen.has(s))).toEqual([]);
  });
});

describe('🔒 both /apps/build gate sites route through the shared predicate', () => {
  for (const rel of BUILD_GATE_SITES) {
    it(`${rel} imports AND calls canAccessAppsBuild`, () => {
      const raw = read(rel);
      // The import — so a call cannot be satisfied by a same-named local helper. Comments
      // stripped but strings kept: the module specifier IS a string.
      expect(
        flatten(raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' '))
      ).toMatch(
        /import\s*\{[^}]*\bcanAccessAppsBuild\b[^}]*\}\s*from\s*['"]~\/shared\/utils\/app-blocks-access['"]/
      );
      // …and a real invocation, not merely a mention in prose.
      expect(stripNonCode(raw)).toMatch(/\bcanAccessAppsBuild\s*\(/);
    });
  }

  it('🔴 the ledger is EXACT — it fails if a site is added OR silently reverted', () => {
    const importers = SCANNED.filter((f) =>
      /import\s*\{[^}]*\bcanAccessAppsBuild\b[^}]*\}\s*from\s*['"]~\/shared\/utils\/app-blocks-access['"]/.test(
        flatten(f.raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' '))
      )
    ).map((f) => f.rel);
    expect(
      importers.sort(),
      'the set of modules deciding `/apps/build` access has changed. TWO is the whole ' +
        'point: the tab and the page. A third gate is how #3899 and #4668 happened — a ' +
        'rule written twice drifts. If a new surface genuinely needs this decision, it ' +
        'should CALL the predicate and be added here deliberately.'
    ).toEqual([...BUILD_GATE_SITES].sort());
  });
});

describe('🔴 no surface re-inlines the build gate', () => {
  it('the rule is spelled out in exactly one module — the one that defines it', () => {
    const offenders = SCANNED.filter((f) => INLINED_BUILD_GATE.test(flatten(f.code))).map(
      (f) => f.rel
    );
    expect(offenders).toEqual([]);
    // The definition lives OUTSIDE the scanned roots and is where the expression belongs.
    // Asserted so "zero offenders" cannot be achieved by the rule having evaporated.
    expect(flatten(stripNonCode(read(DEFINING_MODULE)))).toMatch(INLINED_BUILD_GATE);
  });
});
