import fs from 'fs';
import path from 'path';
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
 * The two page bodies (`pages/apps/index.tsx`, `pages/apps/store-preview/[slug].tsx`)
 * are pinned STRUCTURALLY ONLY — they are Next pages with no component harness, so
 * rendering them would cost more scaffolding than the gate is worth. Stated plainly
 * rather than implied: those two are covered against reversion, not against a
 * wrong-argument call.
 */

const SRC = path.resolve(__dirname, '../../..');

/**
 * Every module that decides store VISIBILITY. Adding a store surface means adding
 * it here — that is the point, not an inconvenience.
 *
 * NOT in this ledger, on purpose: the block-RUNTIME surfaces (`/apps/installed`,
 * `/apps/review`, `/apps/my-submissions`, `/apps/revenue`, `/apps/run/<slug>`)
 * gate on `appBlocks` ALONE because they need the runtime, not just the catalog.
 * Sweeping them in here would be a silent access widening.
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
 * Blank the CONTENTS of comments and string/template literals while preserving
 * length and line breaks, so a gate spelled out in a DOC COMMENT is not mistaken
 * for a live one. This is load-bearing here, not hygiene: the shared predicate's
 * own doc comment and `resolveAppsPageAccess`'s header both contain the literal
 * text `features.appListings || features.appBlocks`, so an unmasked scan would
 * report the very files that were fixed. Self-tested below.
 */
function maskNonCode(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, out.length); i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      blank(i, end === -1 ? code.length : end);
      i = end === -1 ? code.length : end;
    } else if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      blank(i, end === -1 ? code.length : end + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (code[i] === '"' || code[i] === "'" || code[i] === '`') {
      const quote = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === '\\') j++;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Blank COMMENT contents only, leaving string literals intact. Needed for the
 * import assertions: a module specifier IS a string (`from '~/shared/...'`), so
 * the full masker above blanks the very path being asserted — which is exactly
 * how the first version of this file failed all six site checks while the code
 * was correct.
 */
function maskComments(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < Math.min(to, out.length); i++) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') {
      const end = code.indexOf('\n', i);
      blank(i, end === -1 ? code.length : end);
      i = end === -1 ? code.length : end;
    } else if (two === '/*') {
      const end = code.indexOf('*/', i + 2);
      blank(i, end === -1 ? code.length : end + 2);
      i = end === -1 ? code.length : end + 2;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** An open-coded store gate in LIVE code (either operand order). */
const INLINED_GATE =
  /appListings\s*\|\|[^;\n]{0,80}appBlocks|appBlocks\s*\|\|[^;\n]{0,80}appListings/;

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
  return {
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    raw,
    code: maskNonCode(raw),
  };
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
      expect(maskComments(raw)).toMatch(
        /import\s*\{[^}]*\bhasAppsStoreAccess\b[^}]*\}\s*from\s*['"]~\/shared\/utils\/app-blocks-access['"]/
      );
      // …and a real invocation, not merely a mention in prose.
      expect(maskNonCode(raw)).toMatch(/\bhasAppsStoreAccess\s*\(/);
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
        maskComments(f.raw)
      )
    ).map((f) => f.rel);
    expect(importers.sort()).toEqual([...STORE_GATE_SITES].sort());
  });
});

describe('🔴 no store surface re-inlines the gate', () => {
  it('the boolean is spelled out in exactly one module — the one that defines it', () => {
    const offenders = SCANNED.filter((f) => INLINED_GATE.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // The definition itself lives OUTSIDE the scanned roots and is where the
    // expression belongs; assert it is still there so "zero offenders" cannot be
    // achieved by the rule having evaporated entirely.
    expect(maskNonCode(read(DEFINING_MODULE))).toMatch(INLINED_GATE);
  });
});
