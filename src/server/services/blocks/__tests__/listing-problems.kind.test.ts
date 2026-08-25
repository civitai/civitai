import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  computeListingProblems,
  type ListingProblemCode,
  type ListingProblemInput,
  type ListingProblemKind,
} from '~/server/services/blocks/listing-problems';
import type { ListingKind } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * 🔴 ASSIGNABILITY PIN between `ListingKind` (the schema's) and `ListingProblemKind`
 * (this module's deliberate re-declaration). Widening one without the other breaks the
 * `listMine` call site, and this states the relationship where a reader of the type
 * will look for it.
 *
 * 🔴 IT IS NOT THE LOAD-BEARING GUARD, AND SAYING SO IS THE POINT. `tsconfig.json`
 * EXCLUDES `src/**\/__tests__/**`, so these two lines are checked only by the
 * deliberate test-typecheck pass, never by the root `pnpm typecheck` or by CI's
 * typecheck gate. What actually catches a one-sided widening is
 * `app-access.service.ts` passing a `ListingKind` into this type's parameter slot.
 * A previous version of the type's own docblock claimed THIS FILE held the pin while
 * the file contained no reference to `ListingKind` at all — a comment reading as
 * coverage while providing none. Both halves are now true.
 */
const _kindWidensBothWays: [ListingProblemKind, ListingKind] = [
  'onsite' as ListingKind,
  'offsite' as ListingProblemKind,
];
void _kindWidensBothWays;

/**
 * `computeListingProblems` — THE KIND DIMENSION of the three empty-text problems.
 *
 * 🔴 WHY THIS FILE EXISTS. The function was KIND-BLIND: it emitted
 * `empty-description` / `empty-tagline` / `empty-category` with the label "Missing
 * <field>" for EVERY listing. On an OFF-SITE listing that is right — the author typed
 * that copy into the submit wizard and can go and fix it. On an ON-SITE listing it is
 * WRONG, not merely terse: those four scalars have no author surface other than
 * `block.manifest.json`, and `approveRequest`'s (3b-sync) MANIFEST-GOVERNED COPY
 * RE-SYNC (`publish-request.service.ts`, scoped `kind: 'onsite'`) overwrites them from
 * the manifest on EVERY subsequent-version approve. So an on-site author who followed
 * the old advice — assuming they found any surface at all — would have their edit
 * reverted at the next approve. `/apps/mine` was telling them to do something that
 * cannot work.
 *
 * 🔴 EVERY CASE IS PAIRED ACROSS KINDS, deliberately, and the OFF-SITE arm is the
 * POSITIVE CONTROL. An on-site-only assertion would pass just as well against an
 * implementation that gave BOTH kinds the manifest label — which would be a new defect
 * with the same shape as the old one, pointing the other way. The off-site cases below
 * pin the ORIGINAL label strings verbatim (`ORIGINAL_LABEL`), so the two arms can only
 * both pass if the function actually branches.
 *
 * 🔴 LABELS ARE PINNED AS WHOLE NORMALISED STRINGS, not matched by keyword. A
 * `toMatch(/manifest/i)` guard is walkable by re-wording, and the artifact under test
 * here IS prose — the label is the entire deliverable. A cosmetic reword must fail this
 * file; that is the price of the claim being machine-checkable.
 *
 * 🔴 THE CODES AND SEVERITIES ARE ASSERTED KIND-INVARIANT. `problems[]` ships over tRPC
 * to a released `@civitai/cli` (`civitai app doctor`) which branches on `code`. The
 * kind-invariance cases below are what make "this change cannot break that CLI" a
 * tested claim rather than a sentence in a PR body.
 *
 * 🔴 WHICH CASES ARE REGRESSION COVERAGE, AND WHICH ARE MERELY INVARIANT GUARDS.
 * Measured at `origin/main` 4bfd4c16d: 6 of the 23 cases here go RED — the three
 * ON-SITE label cases, "the two arms DIFFER", and the two label-SHAPE cases (category
 * leads with RESUBMIT; description/tagline are the mirror). Those are the regression
 * coverage. The other 17 PASS at base and are INVARIANT GUARDS: they pin behaviour the
 * defect never violated (the off-site labels, the code list, the severities, the
 * never-throws degrade, and the source scanner's own controls). They are not evidence
 * that anything was fixed — they are evidence that nothing ELSE moved, which is the
 * whole wire-contract claim. Both are worth having; only the six should be counted as
 * coverage of the bug.
 */

/** The EXACT pre-change labels. An off-site listing must still produce these, verbatim. */
const ORIGINAL_LABEL = {
  'empty-description': 'Missing description',
  'empty-tagline': 'Missing tagline',
  'empty-category': 'Missing category',
} as const;

/** The on-site labels, spelled out here rather than imported from the implementation. */
const MANIFEST_LABEL = {
  'empty-description':
    'Missing description — set "description" in block.manifest.json and resubmit',
  'empty-tagline': 'Missing tagline — set "tagline" in block.manifest.json and resubmit',
  'empty-category':
    'Missing category — resubmit to apply it; set "category" in block.manifest.json first if your app has none',
} as const;

type TextCode = keyof typeof ORIGINAL_LABEL;

const TEXT_CODES: TextCode[] = ['empty-description', 'empty-tagline', 'empty-category'];
const KINDS: ListingProblemKind[] = ['onsite', 'offsite'];

/** Which INPUT field each text code reads — so a case can empty exactly one. */
const FIELD_OF: Record<TextCode, 'description' | 'tagline' | 'category'> = {
  'empty-description': 'description',
  'empty-tagline': 'tagline',
  'empty-category': 'category',
};

/**
 * A fully-complete listing of a given kind — no problems at all.
 *
 * The asset ids are PAIRWISE DISTINCT (icon 41, cover 53, screenshot count 7) and
 * distinct from every other integer this file names, so an operand swap between two
 * adjacent arguments changes the ANSWER rather than merely the argument. The text
 * values are distinct from each other AND from every label constant above, so no
 * assertion's expected value can be produced by echoing an input.
 */
function complete(kind: ListingProblemKind): ListingProblemInput {
  return {
    kind,
    iconId: 41,
    coverId: 53,
    screenshotCount: 7,
    description: 'A long-form description of what this app actually does.',
    tagline: 'One line about it',
    category: 'utility',
  };
}

/** A listing of `kind` with exactly ONE text field emptied. */
function missingOne(kind: ListingProblemKind, code: TextCode): ListingProblemInput {
  return { ...complete(kind), [FIELD_OF[code]]: null };
}

const problemsOf = (input: ListingProblemInput) => computeListingProblems(input).problems;
const labelOf = (input: ListingProblemInput, code: ListingProblemCode) =>
  problemsOf(input).find((p) => p.code === code)?.label;

// ---------------------------------------------------------------------------
// Fixture guard — the whole suite runs ONE arm if a fixture forgets `kind`.
// ---------------------------------------------------------------------------

describe('🔴 fixture guard — every fixture in this file carries an EXPLICIT, KNOWN kind', () => {
  /**
   * 🔴 THIS GUARD IS NOT CEREMONY. The failure it prevents is silent and total: `kind`
   * is not validated at runtime, and the implementation degrades an unrecognised value
   * to the off-site labels rather than throwing (its "never throws" contract). So a
   * fixture that omitted `kind` — or carried a typo like `'on-site'` — would take the
   * off-site branch, and EVERY on-site case below would then be asserting off-site
   * behaviour against on-site expectations. That fails loudly here, and only here;
   * downstream it would read as an implementation bug.
   *
   * `tsconfig.json` excludes `src/**\/__tests__/**`, so the REQUIRED `kind` field on
   * `ListingProblemInput` is not enforced by `pnpm typecheck` for this file. The type is
   * the enforcement for production call sites; this is the enforcement here.
   */
  const everyFixture: ListingProblemInput[] = [
    ...KINDS.map(complete),
    ...KINDS.flatMap((k) => TEXT_CODES.map((c) => missingOne(k, c))),
  ];

  it('enumerates a non-zero number of fixtures (positive control — an empty list would pass vacuously)', () => {
    // 2 complete + 2 kinds x 3 codes = 8. Named literally so a fixture silently
    // disappearing from the list above cannot leave this describe asserting nothing.
    expect(everyFixture).toHaveLength(8);
  });

  it('every fixture declares a kind drawn from the known set', () => {
    for (const f of everyFixture) {
      expect(KINDS).toContain(f.kind);
    }
  });

  it('the fixtures cover BOTH kinds (a single-arm suite would prove nothing)', () => {
    expect(new Set(everyFixture.map((f) => f.kind))).toEqual(new Set(['onsite', 'offsite']));
  });

  /**
   * 🔴 THE THREE CASES ABOVE ONLY SEE THE FACTORY, AND THAT IS A REAL GAP.
   * `everyFixture` enumerates what `complete()`/`missingOne()` produce — 8 objects. The
   * WIRE CONTRACT describe below builds its inputs as INLINE OBJECT LITERALS instead,
   * and those are invisible to a runtime enumeration. There is no live gap today (every
   * inline literal does carry `kind`), but a future one that forgot it would silently
   * run the unrecognised-kind fallback with the guard above still green — which is
   * precisely the failure this whole describe exists to prevent, arriving through the
   * door the guard does not watch.
   *
   * So this scans THIS FILE'S OWN SOURCE and requires every inline literal handed to
   * `computeListingProblems(` / `problemsOf(` to declare `kind` (directly, or by
   * spreading a factory that does). A literal is anything whose first non-space
   * character after `(` is `{`; a call passing a variable is skipped, because the
   * variable was built by the factory this guard already covers.
   */
  const FIXTURE_SPREADS = ['...complete(', '...missingOne('];

  /** Returns the offending literals — empty means clean. Exported shape kept simple so
   *  the positive control below can drive it with synthetic source. */
  function kindlessLiterals(source: string): string[] {
    const bad: string[] = [];
    for (const fn of ['computeListingProblems(', 'problemsOf(']) {
      let from = 0;
      for (;;) {
        const at = source.indexOf(fn, from);
        if (at === -1) break;
        from = at + fn.length;
        let i = from;
        while (i < source.length && /\s/.test(source[i])) i++;
        if (source[i] !== '{') continue; // a variable, not an inline literal
        // Brace-match the literal.
        let depth = 0;
        let end = i;
        for (; end < source.length; end++) {
          if (source[end] === '{') depth++;
          else if (source[end] === '}' && --depth === 0) break;
        }
        // A literal we cannot brace-match is reported, never silently skipped.
        if (depth !== 0) {
          bad.push('<unparseable literal>');
          continue;
        }
        const literal = source.slice(i, end + 1);
        const declaresKind = /[{,]\s*kind\s*[:,]/.test(literal);
        const spreadsFixture = FIXTURE_SPREADS.some((s) => literal.includes(s));
        if (!declaresKind && !spreadsFixture) bad.push(literal.replace(/\s+/g, ' ').slice(0, 90));
      }
    }
    return bad;
  }

  const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');

  it('🔴 POSITIVE CONTROL — the scanner CAN see a kindless literal', () => {
    // Validate the instrument before reading its verdict. Without this, the clean
    // result below is indistinguishable from a scanner wired to nothing.
    //
    // 🔴 ASSEMBLED FROM PIECES, NOT WRITTEN VERBATIM. The scanner reads this file's own
    // source, so a literal bad example spelled out here would be found by the real scan
    // and fail the clean-file case below — which is exactly what happened on the first
    // run. That is the scanner working; keeping the pieces apart is the fix. (The two
    // GOOD examples below can stay verbatim: they declare `kind` / spread a factory, so
    // the real scan passes over them.)
    const planted = ['problemsOf', '({ iconId: 1, coverId: 2, screenshotCount: 0 });'].join('');
    expect(kindlessLiterals(planted)).toHaveLength(1);
    // ...and does NOT flag the two legitimate shapes.
    expect(kindlessLiterals(`problemsOf({ kind: 'onsite', iconId: 1 });`)).toEqual([]);
    expect(kindlessLiterals(`problemsOf({ ...complete('offsite'), tagline: null });`)).toEqual([]);
  });

  it('🔴 the scanner actually READ this file (a zero over empty input proves nothing)', () => {
    // The other half of the control: a non-zero count of literals was examined.
    expect(ownSource.length).toBeGreaterThan(2000);
    const inlineCalls = (ownSource.match(/(computeListingProblems|problemsOf)\(\s*\{/g) ?? [])
      .length;
    expect(inlineCalls).toBeGreaterThanOrEqual(6);
  });

  it('every INLINE literal passed to the advisory declares a kind', () => {
    expect(kindlessLiterals(ownSource)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The matrix: one case per KIND per CODE.
// ---------------------------------------------------------------------------

describe('empty-text labels are KIND-AWARE — one case per kind per code', () => {
  describe('OFF-SITE (positive control: the ORIGINAL labels, verbatim)', () => {
    for (const code of TEXT_CODES) {
      it(`${code} reads "${ORIGINAL_LABEL[code]}"`, () => {
        expect(labelOf(missingOne('offsite', code), code)).toBe(ORIGINAL_LABEL[code]);
      });
    }
  });

  describe('ON-SITE (names block.manifest.json — the only author surface)', () => {
    for (const code of TEXT_CODES) {
      it(`${code} reads "${MANIFEST_LABEL[code]}"`, () => {
        expect(labelOf(missingOne('onsite', code), code)).toBe(MANIFEST_LABEL[code]);
      });
    }
  });

  it('the two arms DIFFER for all three codes (guards against both arms collapsing to one table)', () => {
    for (const code of TEXT_CODES) {
      expect(labelOf(missingOne('onsite', code), code)).not.toBe(
        labelOf(missingOne('offsite', code), code)
      );
    }
  });

  it('the three ON-SITE labels are distinct from each other (no copy-paste of one field name)', () => {
    const labels = TEXT_CODES.map((c) => labelOf(missingOne('onsite', c), c));
    expect(new Set(labels).size).toBe(3);
  });

  /**
   * 🔴 `empty-category` IS DELIBERATELY ASYMMETRIC WITH THE OTHER TWO, AND THE
   * ASYMMETRY IS THE CORRECTED REASONING — pin it, or a later "let's make these
   * consistent" tidy-up silently restores a wrong diagnosis.
   *
   * `description` and `tagline` are re-derived FROM THE MANIFEST on every sync
   * (`resolveListingDescription` / `resolveListingTagline`), so for those two the
   * manifest genuinely is the whole remedy and the label leads with it.
   *
   * `category` is NOT. It reaches `app_listings.category` only from
   * `AppBlock.category` at an APPROVE, and `setMarketplaceMeta` (moderator curation)
   * writes the BLOCK without touching the LISTING — a state the advisory cannot see.
   * In it, editing the manifest is INERT ((3a)'s null-gate does not fire) while
   * resubmitting is what clears the problem. So this label must lead with the action
   * that always works and mark the manifest key conditional.
   * `block-registry.marketplace-meta.test.ts` pins the curation-write fact this rests on.
   */
  it('🔴 the ON-SITE category label leads with RESUBMIT and marks the manifest CONDITIONAL', () => {
    const label = labelOf(missingOne('onsite', 'empty-category'), 'empty-category')!;
    const resubmitAt = label.toLowerCase().indexOf('resubmit');
    const manifestAt = label.indexOf('block.manifest.json');
    expect(resubmitAt).toBeGreaterThan(-1);
    expect(manifestAt).toBeGreaterThan(-1);
    // Order is the claim: the always-works action comes first.
    expect(resubmitAt).toBeLessThan(manifestAt);
    // ...and the manifest half is hedged, not stated as the remedy.
    expect(label).toMatch(/\bif\b/);
  });

  it('🔴 description/tagline are the MIRROR — manifest FIRST, because for them it IS the whole remedy', () => {
    for (const code of ['empty-description', 'empty-tagline'] as const) {
      const label = labelOf(missingOne('onsite', code), code)!;
      const manifestAt = label.indexOf('block.manifest.json');
      const resubmitAt = label.toLowerCase().indexOf('resubmit');
      expect(manifestAt).toBeGreaterThan(-1);
      expect(resubmitAt).toBeGreaterThan(manifestAt);
      // Unhedged: no conditional, unlike category.
      expect(label).not.toMatch(/\bif\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Wire contract: codes + severities do NOT move with kind.
// ---------------------------------------------------------------------------

describe('🔴 WIRE CONTRACT — codes and severities are KIND-INVARIANT', () => {
  /**
   * The released `@civitai/cli` (`civitai app doctor`) consumes `problems[]` over tRPC
   * and branches on `code`. Renaming a code, dropping one, or SUPPRESSING these three on
   * the on-site arm would all break it — the last of those silently, by making its
   * on-site branch unreachable. These cases pin that none of it happened.
   */
  it('an ON-SITE listing still EMITS all three text codes (they are not suppressed)', () => {
    const codes = problemsOf({
      kind: 'onsite',
      iconId: 41,
      coverId: 53,
      screenshotCount: 7,
      description: null,
      tagline: null,
      category: null,
    }).map((p) => p.code);
    expect(codes).toEqual(['empty-description', 'empty-tagline', 'empty-category']);
  });

  it('both kinds emit the SAME code list, in the SAME order, for the same input', () => {
    const codesFor = (kind: ListingProblemKind) =>
      problemsOf({
        kind,
        iconId: null,
        coverId: null,
        screenshotCount: 0,
        description: null,
        tagline: '   ',
        category: null,
        assetScans: [
          { kind: 'icon', status: 'blocked' },
          { kind: 'cover', status: 'pending' },
        ],
      }).map((p) => p.code);

    const expected: ListingProblemCode[] = [
      'missing-icon',
      'missing-cover',
      'no-screenshots',
      'empty-description',
      'empty-tagline',
      'empty-category',
      'blocked-media',
      'scanning-media',
    ];
    // Asserted against a LITERAL, not against the other kind's output — comparing the
    // two arms to each other would pass if both were equally wrong.
    expect(codesFor('onsite')).toEqual(expected);
    expect(codesFor('offsite')).toEqual(expected);
  });

  it('the three text problems stay ADVISORY on BOTH kinds', () => {
    for (const kind of KINDS) {
      for (const code of TEXT_CODES) {
        expect(problemsOf(missingOne(kind, code)).find((p) => p.code === code)?.severity).toBe(
          'advisory'
        );
      }
    }
  });

  it('the NON-text problems carry byte-identical labels on both kinds', () => {
    const nonText = (kind: ListingProblemKind) =>
      problemsOf({
        kind,
        iconId: null,
        coverId: null,
        screenshotCount: 0,
        description: 'has one',
        tagline: 'has one',
        category: 'utility',
        assetScans: [
          { kind: 'screenshot', status: 'blocked' },
          { kind: 'icon', status: 'pending' },
        ],
      });
    // Positive control: this fixture must actually produce problems, or "identical"
    // would be a comparison of two empty arrays.
    expect(nonText('onsite')).toHaveLength(5);
    expect(nonText('onsite')).toEqual(nonText('offsite'));
  });
});

// ---------------------------------------------------------------------------
// Never-throws.
// ---------------------------------------------------------------------------

describe('🔴 an unrecognised kind degrades to the ORIGINAL labels and never throws', () => {
  /**
   * `kind` reaches the services as a `string` from the `app_listings.kind` COLUMN and is
   * CAST, not parsed. A row carrying anything else must not take down the whole
   * `/apps/mine` page — the module header promises "Never throws". The degrade direction
   * is the off-site (original) labels: inventing manifest advice for a listing that may
   * not be manifest-governed is the actively harmful direction, and it is the exact
   * defect this change exists to fix.
   */
  const weird = (k: string) =>
    computeListingProblems({
      ...complete('offsite'),
      kind: k as ListingProblemKind,
      tagline: null,
    });

  it('does not throw on an unknown kind', () => {
    expect(() => weird('external')).not.toThrow();
    expect(() => weird('')).not.toThrow();
  });

  it('yields the ORIGINAL (off-site) label, not the manifest one', () => {
    expect(weird('external').problems.find((p) => p.code === 'empty-tagline')?.label).toBe(
      ORIGINAL_LABEL['empty-tagline']
    );
  });

  it('a PROTOTYPE key is not mistaken for a known kind (the table must not fail open)', () => {
    // `TEXT_PROBLEM['constructor']` is truthy on a plain object literal, so a `?? default`
    // lookup would silently accept it and then read `.['empty-tagline']` off `Object` —
    // producing `undefined` as the label. Pin that the label is a real string either way.
    const label = weird('constructor').problems.find((p) => p.code === 'empty-tagline')?.label;
    expect(label).toBe(ORIGINAL_LABEL['empty-tagline']);
  });
});
