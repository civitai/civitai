import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';

/**
 * PHASE 3 — the two UI surfaces must not tell a viewer that withdrawing a permission is
 * impossible, because it no longer is.
 *
 * 🔴 WHY THIS IS A SOURCE-TEXT GUARD RATHER THAN A RENDER ASSERTION. The sentence lives in the
 * `permissions` `Tabs.Panel` of `/apps/activity`'s DEFAULT EXPORT — a full page component behind
 * `getServerSideProps`, a feature-flag gate, a tab-visibility predicate and `AppsPageLayout`.
 * Mounting all of that to read one paragraph would be a much larger and more brittle fixture than
 * the claim justifies, and the `ScopeGrantsPanel` the component tier does mount sits BELOW the
 * paragraph. The artifact under test is prose, so the guard pins prose.
 *
 * 🔴 WHAT THIS FILE IS: A LITERAL-REVERT TRIPWIRE PLUS A RETRACTION-MARKER LEDGER. IT IS NOT A
 * REWORDING GUARD, AND AN EARLIER DOCBLOCK HERE CLAIMED IT WAS. That version said *"IT PINS WHOLE
 * NORMALISED SENTENCES, NOT KEYWORDS"* — false as written: `RETRACTED_VIEWER_CLAIMS` holds ONE
 * 35-character clause, matched case-sensitively, so "you cannot withdraw one yet", "withdrawal is
 * not supported yet" and "removing a permission isn't available" all walk it, on any of the five
 * surfaces. The positive half does not compensate either: it is a CONTAINMENT check on three
 * fragments of `activity.tsx` alone, so it forbids no ADDITIONAL false sentence anywhere.
 *
 * What genuinely guards against rewording is the EXACT whole-string pin in
 * `src/components/Apps/AppActivityPage.browser.test.tsx` (`PERMISSIONS_TAB_COPY`, `{ exact: true }`,
 * asserted against the rendered DOM), which this file's sibling honestly calls a pin. That covers
 * `activity.tsx`'s one `<Text>`; the DRAWER's copy has no exact pin at all, which is a real gap and
 * is recorded here rather than papered over. Corrected by the test-review lane.
 *
 * 🔴 THIS IS THE ONE PHASE-3 GUARD WITH A TRUE PRE-CHANGE RED. Every other new test in this phase
 * reads a component, a prop or a testid that does not exist at `a5a34418b6`, so reverting the
 * payload under it produces an IMPORT failure — evidence about the module graph, not about the
 * defect. This file imports nothing from the payload: at base it reds on a real string comparison,
 * because `src/pages/apps/activity.tsx` really does contain the retracted sentence there.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SURFACES = [
  'src/pages/apps/activity.tsx',
  'src/components/AppBlocks/AppPermissionsActivityDrawer.tsx',
  'src/components/Apps/ScopeConsentList.tsx',
  'src/components/Apps/scopeRevoke.tsx',
  'src/components/Apps/scopeConsentRows.ts',
];

/**
 * Files carrying a COMMENT claim about revocation — wider than `SURFACES`, because the defect this
 * set exists for was found OUTSIDE the two surfaces.
 *
 * 🔴 ADDED AFTER A REAL MISS, AND THE MISS IS THE ARGUMENT FOR THE SET'S SHAPE.
 * `src/shared/constants/app-surface-provenance.ts` asserted *"with no remedy available, since
 * nothing in the repo writes a non-null `revoked_at`"* — the same clause phase 3 retracted in three
 * other places, in a module that BOTH permissions surfaces import and whose function is called
 * from both. Phase 3's first pass grepped the surfaces and the components; this file is neither, so
 * it survived. Worse, phase 2 had ALREADY retracted the identical clause in that module's own TEST
 * file and left the source untouched — the guard was fixed and the guarded thing was not, with a
 * green suite over it the whole time.
 */
const COMMENT_CLAIM_FILES = [
  ...SURFACES,
  'src/shared/constants/app-surface-provenance.ts',
  'src/shared/constants/__tests__/app-surface-provenance.test.ts',
  'src/components/Apps/AppActivityPage.browser.test.tsx',
];

/**
 * Clauses that state, as a MECHANISM, that nothing can revoke. Each was true before phase 2.
 *
 * 🔴 THESE ARE NOT BANNED OUTRIGHT — THEY ARE REQUIRED TO CARRY A RETRACTION MARKER. That is the
 * whole design, and the first version of this file got it wrong in both directions at once: it
 * banned comment text outright, which forbade the very quoting this repo's retraction idiom
 * REQUIRES (a superseded claim is quoted beside its correction so the next reader can see what
 * changed), and it therefore could not distinguish a file that has corrected itself from one that
 * never noticed. Requiring the marker separates exactly those two states, which is the thing that
 * matters.
 */
const RETRACTED_MECHANISM_CLAUSES = [
  'nothing writes a non-null `revoked_at`',
  'nothing in the repo writes a non-null `revoked_at`',
  'nothing ever writes a non-null `revoked_at`',
];

/** The markers this repo uses to mark a claim superseded. */
const RETRACTION_MARKERS = ['RETRACTED', 'IS RETRACTED', 'WHAT IS RETRACTED', 'USED TO READ'];

/** Collapse runs of whitespace so a JSX line wrap cannot hide a sentence from the match. */
function normalised(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8').replace(/\s+/g, ' ');
}

/**
 * VIEWER-FACING sentences that asserted revocation was unimplemented.
 *
 * 🔴 VIEWER-FACING ONLY, AND THE SCOPE IS A CORRECTION RATHER THAN A CONVENIENCE. The first
 * version of this list also banned the two COMMENT claims — *"Withdrawing consent is genuinely not
 * implemented"* and *"Do not soften this back into an instruction until a real revoke path
 * exists"* — and it went RED against the correct fix, because this repo's retraction idiom is to
 * QUOTE a superseded claim beside its retraction so the next reader can see what changed. The
 * guard was therefore forbidding the very text the convention requires, and its own docblock
 * asserted the opposite ("the quoted forms do not reproduce these exact spans") about a file it
 * had not been run against. Banning a sentence a comment must be able to quote is not a
 * correctness guard; it is a guard against documenting a correction.
 *
 * So the division of labour is explicit: THIS list pins what a user can read on screen, where a
 * false claim is a real defect; the retraction-marker test below pins that the comment claims are
 * marked rather than silently dropped. Nothing bans a comment from quoting its own history.
 */
const RETRACTED_VIEWER_CLAIMS = ['withdrawing one is not possible yet'];

describe('the permissions copy no longer claims revocation is impossible', () => {
  test.each(SURFACES)('%s shows no "revocation is impossible" copy', (relPath) => {
    const text = normalised(relPath);
    // A positive control on the reader: an empty or missing file would pass every `not.toContain`
    // below and report success having examined nothing.
    expect(text.length, `${relPath} read as empty — this test checks nothing`).toBeGreaterThan(200);
    for (const claim of RETRACTED_VIEWER_CLAIMS) {
      expect(text, `${relPath} still shows the viewer: "${claim}"`).not.toContain(claim);
    }
  });

  /**
   * ⚠️ TWO ARMS WERE DELETED HERE RATHER THAN KEPT, and the deletion is the finding.
   *
   * They asserted that `src/pages/apps/activity.tsx` CONTAINS three fragments of the new tab copy
   * ("Where a permission is yours to give…", "…straight away", "may ask you for it again") and the
   * uninstall-distinction sentence. Every one of those strings is a strict SUBSTRING of
   * `PERMISSIONS_TAB_COPY` in `src/components/Apps/AppActivityPage.browser.test.tsx`, which pins the
   * WHOLE normalised paragraph with `{ exact: true }` against the RENDERED DOM — a strictly stronger
   * claim, in the tier that can see what a viewer actually gets. So the same paragraph was pinned in
   * two files at two strengths, and the weaker one was the newer one: it added no signal and added a
   * second place to relax when the copy legitimately changes. Whoever satisfies the exact pin has
   * satisfied these by construction. Reported by the reuse-review lane.
   *
   * The uninstall distinction is not left unguarded by the deletion — it is covered twice over:
   * by that same exact pin, and by the `REVOKE_BY_UNINSTALL` absence regex in the same sibling file,
   * which is the guard actually aimed at the instruction going false.
   */

  /**
   * 🔴 A KNOWN LIMITATION OF EVERY ARM IN THIS FILE, stated because the first version of it walked
   * straight into the consequence. `normalised()` reads the WHOLE FILE and cannot tell a comment
   * from JSX text. This repo's retraction idiom is to QUOTE a superseded claim beside its
   * correction — so if someone writes a fuller retraction that quotes the old VIEWER-FACING clause
   * verbatim, `RETRACTED_VIEWER_CLAIMS` reds against a strictly better fix. That is exactly the
   * failure the first version produced when it also banned the two comment claims, and narrowing to
   * viewer copy shrank the surface without removing the mechanism.
   *
   * ⚠️ IT IS NOT FIXED BY STRIPPING COMMENTS, and that was considered and rejected: this repo has a
   * worked, expensive precedent for asking regexes to agree about where a syntactic construct ends
   * (`test/component-setup.tsx` records three successive regex attempts at a CSS block, each of
   * which shipped a defect, and the cure was to hand the problem to a real parser). A bad comment
   * stripper here would silently stop checking part of a file, which is worse than this limitation.
   *
   * SO, IF YOU ARE HERE BECAUSE THIS WENT RED ON A RETRACTION YOU WROTE: paraphrase the old
   * viewer-facing clause in the comment rather than quoting it, or move the clause into
   * `RETRACTED_MECHANISM_CLAUSES` below, which requires a retraction MARKER instead of banning the
   * words outright. Do not relax the assertion.
   */

  test.each(COMMENT_CLAIM_FILES)(
    '🔴 %s: any "nothing writes revoked_at" clause carries a retraction marker',
    (relPath) => {
      const text = normalised(relPath);
      expect(text.length, `${relPath} read as empty — this test checks nothing`).toBeGreaterThan(
        200
      );
      const present = RETRACTED_MECHANISM_CLAUSES.filter((c) => text.includes(c));
      if (present.length === 0) return; // the file makes no such claim — nothing to mark.
      const marked = RETRACTION_MARKERS.some((mk) => text.includes(mk));
      expect(
        marked,
        `${relPath} asserts ${JSON.stringify(present)} with NO retraction marker nearby. ` +
          'That mechanism is false since phase 2: `revokeScopes` writes a non-null `revoked_at`. ' +
          'Either delete the clause or mark it retracted and give the real reason.'
      ).toBe(true);
    }
  );

  /**
   * 🔴 THE POSITIVE CONTROL ON THE GUARD ABOVE — without it, the whole `test.each` is satisfied by
   * a clause list that matches nothing (the early `return` makes every file pass vacuously, which
   * is the reassuring-zero shape). This asserts the clause set really does fire on the corpus: at
   * least one file must contain one of these clauses, so the marker requirement is being exercised
   * rather than skipped for every path.
   */
  test('🔴 POSITIVE CONTROL: the retracted-clause set actually matches somewhere', () => {
    const hits = COMMENT_CLAIM_FILES.filter((p) => {
      const text = normalised(p);
      return RETRACTED_MECHANISM_CLAUSES.some((c) => text.includes(c));
    });
    expect(
      hits,
      'no file in the corpus contains any retracted-mechanism clause — the marker guard above ' +
        'returned early for every path and asserted nothing. Either the clauses were reworded ' +
        '(update the list) or the corpus is wrong.'
    ).not.toEqual([]);
  });

  test('🔴 the retracted claims are MARKED as retracted, not silently vanished', () => {
    // This repo's idiom, and the reason the guard above pins live wording rather than banning the
    // words outright: a claim that was once true is quoted beside its retraction so the next reader
    // can see what changed. A silent deletion leaves the next author free to re-derive the old
    // conclusion from scratch.
    const activity = normalised('src/pages/apps/activity.tsx');
    expect(activity).toContain('WHAT IS RETRACTED');
    // …and the replacement explains the MECHANISM, so the sentence can be checked against the code
    // rather than taken on trust.
    expect(activity).toContain('revoked_scopes');
    expect(activity).toContain('fail-closed marker');
    // The drawer's own stale claim — "nothing ever writes a non-null `revoked_at`" — is retracted
    // in place too.
    const drawer = normalised('src/components/AppBlocks/AppPermissionsActivityDrawer.tsx');
    expect(drawer).toContain('IS RETRACTED');
  });
});
