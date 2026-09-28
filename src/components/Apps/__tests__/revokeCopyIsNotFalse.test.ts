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
 * 🔴 IT PINS WHOLE NORMALISED SENTENCES, NOT KEYWORDS. A keyword guard on "not possible" is walked
 * by any reword that keeps the falsehood ("cannot be withdrawn today", "there is no way to remove
 * one yet"), so the forbidden set below is a list of normalised sentences AND the positive half
 * asserts the replacement sentence is actually present — a file that simply deleted the paragraph
 * would pass a negative-only guard while telling the viewer nothing at all.
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

  test('🔴 the tab copy states what the control does, rather than saying nothing', () => {
    // The negative half above is satisfied by DELETING the paragraph. This is the half that is not.
    const text = normalised('src/pages/apps/activity.tsx');
    expect(text).toContain('Where a permission is yours to give, you can remove it here');
    // "straight away" — phase 2 publishes a fail-closed Redis marker the middleware honours on
    // tokens ALREADY minted, so the weaker "at the next token refresh" would understate it.
    expect(text).toContain('the app stops being able to use it straight away');
    // …and re-prompting is disclosed, so a viewer is not surprised by their own next click.
    expect(text).toContain('may ask you for it again');
  });

  test('🔴 the uninstall-is-a-different-thing distinction SURVIVES — it is still true', () => {
    // The half of the old sentence that phase 3 must NOT drop. Neither uninstall path touches
    // `app_user_scope_grants`, so an uninstall still does not withdraw consent, and the copy that
    // replaced the retracted claim has to keep saying so.
    const text = normalised('src/pages/apps/activity.tsx');
    expect(text).toContain(
      'Removing an install on the Installs tab is a different thing and does not withdraw a permission'
    );
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
