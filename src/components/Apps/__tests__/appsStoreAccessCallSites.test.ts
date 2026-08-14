import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * 🔒 THE CALL-SITE LEDGER for the App-store visibility gate.
 *
 * WHY THIS FILE EXISTS — measured, not hypothetical. The PR that extracted
 * `hasAppsStoreAccess` converted SIX sites, but only TWO of them
 * (`resolveAppsPageAccess`, `AppsSubNav`) had behavioural tests that could
 * observe the conversion. An adversarial audit reverted the other four to
 * `!!features.appBlocks` and re-ran the ENTIRE cited suite — 93/93 component +
 * 21/21 unit still GREEN. The mutant survived completely. A consolidation that
 * nothing pins is a comment, not an invariant.
 *
 * So this asserts the RELATIONSHIP rather than any one component: the exact set
 * of modules that decide "may this viewer see the /apps store", that each one
 * routes through the shared predicate, and that none of them re-inlines the
 * boolean. It fails when the ledger GROWS (a new store surface that forgot the
 * predicate) and when it SHRINKS (a site reverted to open-coding).
 *
 * 🔴 A STRUCTURAL CHECK IS NOT A BEHAVIOURAL ONE. This proves each site CALLS
 * the predicate; it cannot prove the call was passed the right argument, and it
 * would type-check past `hasAppsStoreAccess(someOtherObject)`. Behavioural
 * coverage lives alongside it and is deliberately NOT replaced by this file:
 *   - `AppsSubNav.storeGate.browser.test.tsx`      — the sub-nav's rendered output
 *   - `AppListingsMarketplaceBody.storeGate.browser.test.tsx` — the grid query gate
 *   - `hasAppsStoreAccess.test.ts`                 — the predicate + the SSR seam
 *
 * THREE of the six sites are pinned STRUCTURALLY ONLY — `pages/apps/index.tsx`
 * and `pages/apps/store-preview/[slug].tsx` (Next pages, no component harness) and
 * `components/Apps/RelatedListings.tsx` (its only existing test covers the pure
 * selection helper and never mounts the component, so it never touches
 * `useFeatureFlags` / `canSeeStore`). Those three are covered against REVERSION,
 * not against a wrong-argument call. Stated rather than implied.
 *
 * 🔴 AND THE SCOPE THAT MATTERS IN CI: the component suites above are REPORT-ONLY
 * (`preview / component-tests`) and do not block a merge. This unit-project ledger
 * does. So in CI all six sites are pinned STRUCTURALLY ONLY, by this file — which
 * is precisely why a hole in its masker (see below) is worth more than it looks.
 *
 * 🔴 TWO MEASURED LIMITS OF THIS FILE — issue #3932, not fixed here. Read them
 * before treating a green run as "no site re-inlines the gate":
 *   1. `INLINED_GATE` matches two flag names in PROXIMITY inside ONE expression.
 *      Four re-inlining shapes evade it and were verified green: hoisted locals
 *      (`const a = features.appListings; … a || b`), names split across a `;` (the
 *      `[^;{}]` class stops there by design), a ternary, and
 *      `[features.appListings, features.appBlocks].some(Boolean)`. Widening the
 *      NAME list (as the external-only term did) does not touch the SHAPE.
 *   2. The "EXACT" assertion below pins DIRECT importers only, so a site that
 *      reaches the gate transitively is invisible to it — including
 *      `pages/apps/[appBlockId]/index.tsx`, which routes through
 *      `resolveLegacyAppRoute` → `resolveAppsPageAccess`. That is the site a real
 *      disclosure defect appeared at, so the blindness is not academic.
 */

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every module INSIDE {@link SCAN_ROOTS} that decides store VISIBILITY. Adding a
 * store surface under those roots means adding it here — that is the point, not
 * an inconvenience.
 *
 * ── NOT in this ledger, on purpose ──────────────────────────────────────────
 *
 * 1. The block-RUNTIME surfaces (`/apps/installed`, `/apps/review`,
 *    `/apps/my-submissions`, `/apps/revenue`, `/apps/run/<slug>`) gate on
 *    `appBlocks` ALONE because they need the runtime, not just the catalog.
 *    Sweeping them in here would be a silent access widening.
 *
 * 2. 🔴 `components/AppLayout/AppHeader/appsNavVisibility.ts` — `marketplace:
 *    !!features.appBlocks`, which drives the user-menu "Apps" → `/apps` entry.
 *    That IS a store-visibility decision and it is NOT converted, deliberately:
 *    that module's own doc comment states the entry "stays gated on `appBlocks`",
 *    so it is a standing decision, not drift. It is also outside `SCAN_ROOTS`
 *    (`components/AppLayout`), so grow-detection below is STRUCTURALLY BLIND to
 *    it — do not read the ledger's exactness as covering it.
 *
 *    CONSEQUENCE, recorded so nobody rediscovers it during the launch: for the
 *    `{appListings, NOT appBlocks}` cohort the store renders but has NO in-product
 *    entry point — that menu item is the only route TO `/apps` (the sub-nav's
 *    Marketplace tab only appears once you are already on `/apps/*`). Reachable by
 *    direct URL only. Tracked in issue #3907; not this file's to fix.
 *
 *    🔴 THE EXTERNAL-ONLY COHORT INHERITS THAT GAP, AND IS THE FIRST REAL POPULATION
 *    TO HIT IT. `{appListingsPublicExternal, NOT appBlocks, NOT appListings}` holders
 *    now pass the six gates below but the user-menu entry still reads `appBlocks`
 *    alone, so `/apps` is direct-URL-only for them. Until #3907 lands, an
 *    external-only rollout needs its own entry point (a link in the announcement, a
 *    campaign URL) — the store being reachable is NOT the same as it being findable.
 *    Deliberately out of scope here: converting that menu item is a product decision
 *    on a module with its own standing doc, not a mechanical alignment.
 */
const STORE_GATE_SITES = [
  'components/Apps/AppListingsMarketplaceBody.tsx',
  'components/Apps/AppsSubNav.tsx',
  'components/Apps/RelatedListings.tsx',
  'components/Apps/resolveAppsPageAccess.ts',
  'pages/apps/index.tsx',
  'pages/apps/store-preview/[slug].tsx',
] as const;

/** The ONE module allowed to spell the boolean out — it defines it. */
const DEFINING_MODULE = 'shared/utils/app-blocks-access.ts';

/** Directories scanned for a re-inlined gate. The definition lives outside them. */
const SCAN_ROOTS = ['components/Apps', 'pages/apps'];

/**
 * 🔴 MASKING RUNS THROUGH THE REAL TypeScript PARSER, NOT A QUOTE SCANNER.
 *
 * Masking is load-bearing, not hygiene: the shared predicate's own doc comment and
 * `resolveAppsPageAccess`'s header both contain the literal text
 * `features.appListings || features.appBlocks`, so an UNMASKED scan reports the
 * very files that were fixed. But a hand-rolled masker is worse than none, because
 * it fails SILENTLY and in one direction — toward a reassuring zero.
 *
 * The previous version treated every `'` as a string delimiter. An ASCII
 * apostrophe in JSX TEXT (`The app's data…`, `installed.tsx:132`) therefore opened
 * a phantom string that ran to EOF, blanking 71% of that file (14,229 / 20,037
 * chars) and 17% of `my-submissions.tsx`. Measured with a discriminating control,
 * not inferred: an open-coded `f.appListings || f.appBlocks` planted AFTER the
 * apostrophe was INVISIBLE (suite 14/14 green); the identical probe planted BEFORE
 * it was caught. A live store gate could have shipped through the hole.
 *
 * JSX text, template-literal chunks, regex literals and nested quotes are exactly
 * the cases an ad-hoc lexer gets wrong, so the parser owns it now: parse as TSX,
 * blank the ranges the AST says are literals, then strip comments from the result
 * (safe at that point — every string is already blanked, so no `//` inside one can
 * be misread). Expression holes inside `${...}` are children of the template node
 * and are deliberately LEFT LIVE: they are real code.
 */
function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function blankRanges(text: string, ranges: Array<[number, number]>): string {
  const out = text.split('');
  for (const [from, to] of ranges) {
    for (let i = Math.max(from, 0); i < Math.min(to, out.length); i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  }
  return out.join('');
}

/** Ranges the PARSER classifies as literal text — never live code. */
function literalRanges(sf: ts.SourceFile): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node) => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.JsxText:
        ranges.push([node.getStart(sf), node.getEnd()]);
        break;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return ranges;
}

/** Blank comments AND literals. Use for anything that scans for live code. */
function maskNonCode(code: string, fileName = 'probe.tsx'): string {
  const withoutLiterals = blankRanges(code, literalRanges(parseTsx(fileName, code)));
  // Safe now: every string/template/JSX-text range is spaces, so a `//` or `/*`
  // that survives can only be a real comment.
  return stripComments(withoutLiterals);
}

/**
 * Blank COMMENT contents only, leaving string literals intact. Needed for the
 * import assertions: a module specifier IS a string (`from '~/shared/...'`), so
 * the full masker blanks the very path being asserted — which is exactly how the
 * first version of this file failed all six site checks while the code was
 * correct. Comment ranges come from the parser, so an apostrophe cannot desync it.
 */
function maskComments(code: string, fileName = 'probe.tsx'): string {
  const sf = parseTsx(fileName, code);
  const ranges: Array<[number, number]> = [];
  const seen = new Set<string>();
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const c of found ?? []) {
      const key = `${c.pos}:${c.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push([c.pos, c.end]);
      }
    }
  };
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(code, node.getFullStart()));
    add(ts.getTrailingCommentRanges(code, node.getEnd()));
    node.forEachChild(visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(code, 0));
  return blankRanges(code, ranges);
}

/** Line + block comment strip, run only on text whose literals are already blank. */
function stripComments(code: string): string {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      ranges.push([i, stop]);
      i = stop;
    } else if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      ranges.push([i, stop]);
      i = stop;
    } else {
      i++;
    }
  }
  return blankRanges(code, ranges);
}

/**
 * The flag names the store gate is built from. The predicate is
 * `appListings || appBlocks || appListingsPublicExternal` — the third term admits
 * the EXTERNAL-ONLY cohort, who reach the store and are then scoped SERVER-side to
 * `kind='offsite'` listings. Any TWO of these joined by a logical operator in live
 * code under SCAN_ROOTS is a re-inlined gate.
 *
 * 🔴 Kept as data, not baked into one literal regex, because the gate GREW: a
 * two-name regex would have gone on reporting a clean zero for a site that
 * re-inlined `appListings || appListingsPublicExternal` — the newest and least
 * familiar half of the rule, i.e. the one most likely to be open-coded by someone
 * who has not read this file.
 */
const STORE_FLAG_NAMES = ['appListingsPublicExternal', 'appListings', 'appBlocks'] as const;

/**
 * An open-coded store gate in LIVE code.
 *
 * Deliberately matched on PROXIMITY + a logical operator rather than one literal
 * shape. The previous single-line `X || Y` regex was evaded by every form the
 * codebase can actually produce: a prettier-wrapped multi-line OR (the formatter
 * inserts the newline for you), a De Morgan negation
 * (`!features.appListings && !features.appBlocks`), and a `??` chain. Whitespace is
 * collapsed first so line wrapping is irrelevant, and `[^;{}]` keeps a match inside
 * one expression rather than spanning statements.
 *
 * `\b` after each flag name matters twice over: it stops `appBlocksPages` /
 * `appBlocksAuthor` — different flags with their own rules — from being read as
 * `appBlocks`, and it stops `appListingsPublicExternal` from being read as
 * `appListings`. Both directions are pinned by the masker controls below.
 */
const INLINED_GATE = new RegExp(
  STORE_FLAG_NAMES.flatMap((a) =>
    STORE_FLAG_NAMES.filter((b) => b !== a).map(
      (b) => `${a}\\b[^;{}]{0,120}?(?:\\|\\||&&|\\?\\?)[^;{}]{0,120}?${b}\\b`
    )
  ).join('|')
);

/** Collapse whitespace so a prettier line-wrap cannot hide a gate from the regex. */
function flatten(code: string): string {
  return code.replace(/\s+/g, ' ');
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SCANNED = SCAN_ROOTS.flatMap((root) => walk(path.join(SRC, root))).map((file) => {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  return { rel, raw, code: maskNonCode(raw, file), comments: maskComments(raw, file) };
});

describe('the masker (validate the instrument before reading its verdict)', () => {
  it('blanks a gate written in a line comment, a block comment and a string', () => {
    expect(maskNonCode('// features.appListings || features.appBlocks')).not.toMatch(INLINED_GATE);
    expect(maskNonCode('/* a = features.appListings || features.appBlocks; */')).not.toMatch(
      INLINED_GATE
    );
    expect(maskNonCode("const s = 'features.appListings || features.appBlocks';")).not.toMatch(
      INLINED_GATE
    );
  });

  it('🔴 POSITIVE CONTROL: it does NOT blank real code (else every scan below is vacuous)', () => {
    // If this ever stops matching, the "no re-inlined gate" test becomes a probe
    // wired to nothing and would report a reassuring zero forever.
    expect(maskNonCode('if (!(features.appListings || features.appBlocks)) return null;')).toMatch(
      INLINED_GATE
    );
    expect(maskNonCode('enabled: !!(features.appBlocks || features.appListings),')).toMatch(
      INLINED_GATE
    );
    expect(maskNonCode('const x = hasAppsStoreAccess(features);')).toContain('hasAppsStoreAccess');
  });

  it('preserves line count so a reported offender can be located', () => {
    const src = 'a\n// x\n/* y\nz */\nb\n';
    expect(maskNonCode(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  /**
   * 🔴 THE REGRESSION THAT MOTIVATED THE PARSER REWRITE.
   *
   * The old quote-scanner treated every `'` as a delimiter, so an APOSTROPHE IN
   * JSX TEXT opened a phantom string to EOF and blanked 71% of `installed.tsx`.
   * The masker's controls at the time were all synthetic one-liners, which is
   * exactly why they could not see it — none of them contained JSX. These use
   * REALISTIC shapes, per the rule that a scanner allowlists its own examples.
   */
  it('🔴 an apostrophe in JSX TEXT does not desync the masker (71%-blind regression)', () => {
    const src = [
      'export function C() {',
      '  return (',
      '    <Text>',
      "      The app's data and any other installs of it are untouched.",
      '    </Text>',
      '  );',
      '}',
      'const gate = features.appListings || features.appBlocks;',
    ].join('\n');
    const masked = maskNonCode(src, 'probe.tsx');
    // Code AFTER the apostrophe must survive — this is the whole bug.
    expect(masked).toMatch(INLINED_GATE);
    // …and the JSX prose itself is still treated as non-code.
    expect(masked).not.toContain('any other installs');
  });

  it('🔴 the real installed.tsx keeps its post-apostrophe code visible', () => {
    // Anchored on the FILE that broke it, not a fixture: a synthetic case can be
    // fixed while the real one still desyncs (different JSX nesting, entities…).
    const raw = read('pages/apps/installed.tsx');
    const masked = maskNonCode(raw, 'installed.tsx');
    expect(raw).toMatch(/app's/); // the trigger is still present upstream
    // Both live gates sit AFTER it (~line 460 and ~500) and must remain readable.
    expect(masked.match(/features\.appBlocks/g) ?? []).toHaveLength(
      (raw.match(/features\.appBlocks/g) ?? []).length
    );
    // Blanking must be bounded: the file cannot be mostly spaces.
    const blanked = masked.split('').filter((c) => c === ' ').length;
    expect(blanked / masked.length).toBeLessThan(0.55);
  });

  it('nested quotes, templates and regex literals do not desync it either', () => {
    const src = [
      'const a = "it\'s fine";',
      'const b = `a ${features.appListings} b`;',
      "const c = /don't/.test(x);",
      'const gate = features.appListings || features.appBlocks;',
    ].join('\n');
    const masked = maskNonCode(src, 'probe.ts');
    expect(masked).toMatch(INLINED_GATE);
    // The template EXPRESSION hole is live code and must survive. (Its delimiters
    // `${` and `}` belong to the TemplateHead/Tail TOKENS and are correctly
    // blanked — only the expression between them is code.)
    expect(masked).toContain('features.appListings');
    // …while the literal chunks around it are blanked, apostrophe and all.
    expect(masked).not.toContain("it's fine");
    expect(masked).not.toContain("don't");
  });

  it('🔴 catches the evasions the single-line regex missed', () => {
    const cases: Record<string, string> = {
      'prettier-wrapped multi-line OR':
        'const ok =\n  features.appListings ||\n  features.appBlocks;',
      'De Morgan negation': 'if (!features.appListings && !features.appBlocks) return null;',
      'nullish chain': 'const ok = features.appListings ?? features.appBlocks;',
      destructured: 'const ok = appListings || appBlocks;',
      'reversed order': 'const ok = features.appBlocks || features.appListings;',
    };
    for (const [label, src] of Object.entries(cases)) {
      expect(flatten(maskNonCode(src, 'probe.ts')), label).toMatch(INLINED_GATE);
    }
  });

  it('does NOT confuse sibling flags that have their own rules', () => {
    // `appBlocksPages` / `appBlocksAuthor` are different gates; a `\b`-less regex
    // would read them as `appBlocks` and flag legitimate code.
    expect(
      flatten(maskNonCode('const x = features.appListings || features.appBlocksPages;', 'p.ts'))
    ).not.toMatch(INLINED_GATE);
    expect(
      flatten(maskNonCode('const x = features.appListings || features.appBlocksAuthor;', 'p.ts'))
    ).not.toMatch(INLINED_GATE);
  });

  /**
   * 🔴 THE THIRD TERM. `appListingsPublicExternal` admits the EXTERNAL-ONLY cohort
   * and is now part of the gate, so a site re-inlining a pair that includes it must
   * be caught — while `appListingsPublicExternal` alone must NOT be mistaken for
   * `appListings` (they are different flags with different meanings, and the prefix
   * relationship makes that the easy mistake for a `\b`-less regex).
   */
  it('🔴 catches a re-inlined gate built from the EXTERNAL-only term', () => {
    const cases: Record<string, string> = {
      'external OR listings':
        'const ok = features.appListings || features.appListingsPublicExternal;',
      'external OR blocks': 'const ok = features.appListingsPublicExternal || features.appBlocks;',
      'external first, wrapped':
        'const ok =\n  features.appListingsPublicExternal ||\n  features.appListings;',
      'De Morgan with external':
        'if (!features.appBlocks && !features.appListingsPublicExternal) return null;',
      'destructured external': 'const ok = appListingsPublicExternal || appBlocks;',
    };
    for (const [label, src] of Object.entries(cases)) {
      expect(flatten(maskNonCode(src, 'probe.ts')), label).toMatch(INLINED_GATE);
    }
  });

  it('🔴 does NOT read appListingsPublicExternal as appListings (prefix collision)', () => {
    // A single mention of the longer name, OR-ed with an unrelated flag, is not a
    // store gate. Without `\b` the `appListings` alternative would match its prefix
    // and report a false offender at every external-cohort call site.
    expect(
      flatten(
        maskNonCode('const x = features.appListingsPublicExternal || features.canViewNsfw;', 'p.ts')
      )
    ).not.toMatch(INLINED_GATE);
    expect(
      flatten(maskNonCode('const x = features.appListingsPublicExternal;', 'p.ts'))
    ).not.toMatch(INLINED_GATE);
    // The sharp case: a hypothetical SIBLING of the longest name. Only the `\b` on
    // `appListingsPublicExternal` itself rejects this — every other guard in this
    // file passes it either way, so this is the one assertion that dies for that
    // specific reason.
    expect(
      flatten(
        maskNonCode(
          'const x = features.appListingsPublicExternalOverride || features.appBlocksPages;',
          'p.ts'
        )
      )
    ).not.toMatch(INLINED_GATE);
  });

  it('🔴 maskComments keeps STRINGS (the import-path regression this file already hit)', () => {
    // The first version of this file masked strings too, so `from '~/shared/...'`
    // was blanked and all six site checks failed against correct code.
    const line = "import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';";
    expect(maskComments(line)).toContain('~/shared/utils/app-blocks-access');
    expect(maskNonCode(line)).not.toContain('~/shared/utils/app-blocks-access');
    // …while still blanking a commented-out import (the false-positive it prevents).
    expect(maskComments(`// ${line}`)).not.toContain('~/shared/utils/app-blocks-access');
  });
});

describe('the scan itself (a zero must be earned, not assumed)', () => {
  it('walked a plausible number of store modules', () => {
    // Floor deliberately well below the live count so retiring one file does not
    // red the guard; the point is that the walk is not returning an empty set.
    expect(SCANNED.length).toBeGreaterThanOrEqual(40);
  });

  it('every ledger site was actually reached by the walk', () => {
    const seen = new Set(SCANNED.map((f) => f.rel));
    expect(STORE_GATE_SITES.filter((s) => !seen.has(s))).toEqual([]);
  });
});

describe('🔒 every store-visibility site routes through the shared predicate', () => {
  for (const rel of STORE_GATE_SITES) {
    it(`${rel} imports AND calls hasAppsStoreAccess`, () => {
      const raw = read(rel);
      // The import — so a call cannot be satisfied by a same-named local helper.
      // Comment-masked only: the module specifier is a string literal.
      expect(flatten(maskComments(raw, rel))).toMatch(
        /import\s*\{[^}]*\bhasAppsStoreAccess\b[^}]*\}\s*from\s*['"]~\/shared\/utils\/app-blocks-access['"]/
      );
      // …and a real invocation, not merely a mention in prose.
      expect(maskNonCode(raw, rel)).toMatch(/\bhasAppsStoreAccess\s*\(/);
    });
  }

  /**
   * 🔴 THE MUTANT THAT SURVIVED. Reverting any of the four unpinned sites to
   * `!!features.appBlocks` left the whole cited suite green. It cannot now: the
   * revert deletes the call, so that site's case above goes red, and the site
   * disappears from the ledger below.
   */
  it('the ledger is EXACT — it fails if a site is added OR silently reverted', () => {
    const importers = SCANNED.filter((f) =>
      /import\s*\{[^}]*\bhasAppsStoreAccess\b[^}]*\}\s*from\s*['"]~\/shared\/utils\/app-blocks-access['"]/.test(
        flatten(f.comments)
      )
    ).map((f) => f.rel);
    // ⚠️ "EXACT" is scoped to SCAN_ROOTS. `components/AppLayout/AppHeader/
    // appsNavVisibility.ts` is a real store-visibility decision that lives outside
    // them and is deliberately excluded — see the STORE_GATE_SITES doc. This
    // assertion cannot and does not speak for it.
    expect(importers.sort()).toEqual([...STORE_GATE_SITES].sort());
  });
});

describe('🔴 no store surface re-inlines the gate', () => {
  it('the boolean is spelled out in exactly one module — the one that defines it', () => {
    const offenders = SCANNED.filter((f) => INLINED_GATE.test(flatten(f.code))).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // The definition itself lives OUTSIDE the scanned roots and is where the
    // expression belongs; assert it is still there so "zero offenders" cannot be
    // achieved by the rule having evaporated entirely.
    expect(flatten(maskNonCode(read(DEFINING_MODULE), DEFINING_MODULE))).toMatch(INLINED_GATE);
  });
});
