import fs from 'fs';
import path from 'path';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * A `vi.mock('~/utils/notifications', …)` factory that does NOT spread the real module is a
 * LEDGERED liability, and this file is the ledger. Node `unit` project — the tier that
 * EXECUTES this assertion, which matters because the failure it pins is invisible in the
 * browser tier it happens in: an import failure collects 0 tests, so it shows up as a file
 * count, never as a failing assertion.
 *
 * WHAT BROKE (#5102). #5082 (`b599d8d2da`, 2026-09-23) added `showWarningNotification` to
 * `~/components/HideUserButton/BlockUserButton`. Five browser suites under
 * `src/components/Apps` reach that module through
 * `OffsiteReviewQueue → AppListingDetailBody → AppListingComments → CommentsV2/Comment`, and
 * each mocked `~/utils/notifications` with a factory naming only `showSuccessNotification`
 * and `showErrorNotification`. A wholesale factory REPLACES the module, so the new named
 * import had nothing to bind to:
 *
 *   SyntaxError: The requested module '/src/utils/notifications.tsx' does not provide an
 *   export named 'showWarningNotification'
 *
 * 🔴 AND THE FILE THEN FAILS TO IMPORT, WHICH IS NOT THE SAME AS FAILING. Measured on
 * `origin/main` at `ba6ce2b835`: `Test Files 5 failed | 257 passed (262)` next to
 * `Tests 2808 passed (2808)` — zero failing assertions, and the 40 tests those five files
 * contribute were not running at all. `preview / component-tests` had been red on every PR
 * in the repo for ~a day, and four PRs were merged past it on written acceptances.
 *
 * WHY A LEDGER AND NOT A REPO-WIDE RULE. Measured 2026-09-24 on `origin/main`: 44 test files
 * carry a non-spreading `~/utils/notifications` factory; this PR converts the 5 that broke,
 * leaving the 39 below. A repo-wide "must spread" check would be red on all 39 — and a
 * permanently-red gate is worse than no gate, which is the whole subject of #5102. So the
 * tolerated set is enumerated instead, and the assertion is EQUALITY: the set may not GROW
 * (a new wholesale factory is refused at the blocking node tier) and may not SHRINK silently
 * (converting one is a one-line ledger edit, so the count in this file stays true).
 *
 * WHY NOT `local-rules/no-wholesale-module-mock` INSTEAD. That rule is the detector used
 * below, but its registry in `.eslintrc.js` deliberately excludes `~/utils/notifications`:
 * its stated admission test needs ≥15 exported bindings and ZERO existing violators, and
 * this module has 7 exports and 39. 🔴 The ≥15 criterion is FALSIFIED by this incident — the
 * hazard is REACH, not surface width: 7 exports and 347 non-test `src/` importers took out
 * five suites. Widening the registry needs those 39 converted first and is real, separate
 * work; it is not smuggled in here. See the note in `.eslintrc.js`.
 *
 * Sibling guard, same defect class one module over:
 * `src/components/AppBlocks/__tests__/featureFlagsMockCompleteness.test.ts`.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MODULE = '~/utils/notifications';

/**
 * 🔴 THIS FILE EXCLUDES ITSELF. The controls below feed the detector literal
 * `vi.mock('~/utils/notifications', …)` source, so a scan that read this file's own text
 * would judge its own fixtures — a guard failing on its own examples.
 */
const SELF = path.join(__dirname, 'notificationsMockSpread.test.ts');

/**
 * The 5 files #5102 converted. Pinned SEPARATELY from the ledger so the regression claim has
 * its own assertion and its own failure message: these are the files that were actually red,
 * and this is the half that goes red at `origin/main`.
 */
const FIXED_BY_5102 = [
  'src/components/Apps/CombinedReviewModal.browser.test.tsx',
  'src/components/Apps/ConnectScopesPanel.browser.test.tsx',
  'src/components/Apps/OffsiteReportsQueue.browser.test.tsx',
  'src/components/Apps/OffsiteReviewModal.focus.browser.test.tsx',
  'src/components/Apps/OffsiteReviewQueue.browser.test.tsx',
].sort();

/**
 * Every test file whose `~/utils/notifications` factory does not spread the original TODAY.
 * Tolerated, not approved: each is one `...(await importOriginal<typeof M>())` away from
 * being immune to the next export added to that module. Shrink this list, never grow it.
 */
const TOLERATED = [
  'src/components/Account/DeleteCard.browser.test.tsx',
  'src/components/Account/SettingsCard.earlyAdopter.browser.test.tsx',
  'src/components/Announcements/__tests__/creator-announcement-mutations.test.ts',
  'src/components/Apps/ActivePreviewsPanel.browser.test.tsx',
  'src/components/Apps/AgentReviewChat.browser.test.tsx',
  'src/components/Apps/AgentReviewPanel.browser.test.tsx',
  'src/components/Apps/AppCollaboratorsPanel.browser.test.tsx',
  'src/components/Apps/AppListingsModerationTable.browser.test.tsx',
  'src/components/Apps/ExternalSubmitForm.browser.test.tsx',
  'src/components/Apps/ExternalSubmitForm.edit.browser.test.tsx',
  'src/components/Apps/ExternalSubmitForm.ownerUnpublished.browser.test.tsx',
  'src/components/Apps/ExternalSubmitForm.reducedMotion.browser.test.tsx',
  'src/components/Apps/ListingAssetStep.browser.test.tsx',
  'src/components/Apps/ListingHistoryPanel.browser.test.tsx',
  'src/components/Apps/ListingPublishingPanel.browser.test.tsx',
  'src/components/Apps/ManifestEditForm.browser.test.tsx',
  'src/components/Apps/MessageAppOwnerModal.browser.test.tsx',
  'src/components/Apps/MyAppsBody.browser.test.tsx',
  'src/components/Apps/MySubmissionsList.browser.test.tsx',
  'src/components/Apps/MySubmissionsList.buildFailure.browser.test.tsx',
  'src/components/Apps/OffsiteSubmissionsList.browser.test.tsx',
  'src/components/Apps/OnsiteReviewModal.browser.test.tsx',
  'src/components/Apps/ReportListingModal.browser.test.tsx',
  'src/components/Apps/ReviewActionBar.browser.test.tsx',
  'src/components/Apps/ReviewDetailView.browser.test.tsx',
  'src/components/Apps/ReviewListingButton.browser.test.tsx',
  'src/components/Apps/ReviewListingButton.storeScope.browser.test.tsx',
  'src/components/AssociatedModels/AssociateModels.browser.test.tsx',
  'src/components/Buzz/InteractiveTipBuzzButton.browser.test.tsx',
  'src/components/Challenge/__tests__/ChallengeUpsertForm.browser.test.tsx',
  'src/components/Feedback/FeedbackDrawer.browser.test.tsx',
  'src/components/Feedback/FeedbackPrompt.browser.test.tsx',
  'src/components/RemixGallery/RemixGallerySubmitModal.browser.test.tsx',
  'src/hooks/__tests__/useCFImageUpload.test.ts',
  'src/hooks/__tests__/useFormStorage.test.ts',
  'src/tests/pages/apps/invites-transfer-blocked.browser.test.tsx',
  'src/tests/pages/apps/listing-collaborators-transfer.browser.test.tsx',
  'src/tests/pages/apps/listing-edit-owner-unpublished-tabs.browser.test.tsx',
  'src/tests/pages/apps/listing-media-page.browser.test.tsx',
].sort();

/**
 * 🔴 THE DETECTOR IS THE REPO'S OWN RULE, NOT A REGEX. `local-rules/
 * no-wholesale-module-mock` already answers "can I prove from the AST that this factory
 * carries the original's exports forward?", including the shapes a textual check gets wrong
 * in both directions (`async (orig) => ({ ...(await orig()) })` is safe; a factory that
 * merely mentions the word `importOriginal` is not). Re-implementing that here would be a
 * second copy of the predicate, free to disagree with the one ESLint enforces.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const localRules = require(path.join(REPO_ROOT, 'eslint-local-rules.js'));

const linter = new Linter({ configType: 'eslintrc' });
linter.defineRule('local/no-wholesale-module-mock', localRules['no-wholesale-module-mock']);
// eslint-disable-next-line @typescript-eslint/no-var-requires
linter.defineParser('ts', require(path.join(REPO_ROOT, 'node_modules/@typescript-eslint/parser')));

const LINT_CONFIG = {
  parser: 'ts',
  parserOptions: {
    ecmaVersion: 'latest' as const,
    sourceType: 'module' as const,
    ecmaFeatures: { jsx: true },
  },
  rules: { 'local/no-wholesale-module-mock': ['error', { modules: [MODULE] }] },
} as const;

/** How many `no-wholesale-module-mock` reports this source draws for `MODULE`. */
function violationCount(source: string, filename: string): number {
  return linter
    .verify(source, LINT_CONFIG as unknown as Parameters<Linter['verify']>[1], filename)
    .filter((m) => m.ruleId === 'local/no-wholesale-module-mock').length;
}

/**
 * Every `*.test.ts` / `*.test.tsx` under `src/`, walked directly rather than globbed — `grep
 * -r`/glob helpers here honour `.gitignore` and would silently skip generated trees, and
 * `__screenshots__` holds DIRECTORIES named `<suite>.browser.test.tsx` that must not be read
 * as files.
 */
function walkTests(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '__screenshots__'
      )
        continue;
      walkTests(p, out);
    } else if (/\.test\.tsx?$/.test(entry.name) && p !== SELF) {
      out.push(p);
    }
  }
  return out;
}

const testFiles = walkTests(path.join(REPO_ROOT, 'src'));

/**
 * The content prefilter is an OPTIMISATION, and it cannot hide a violation: the rule only
 * fires on a specifier that canonicalises to `~/utils/notifications`, and every spelling of
 * that — the alias, a template literal, a relative `../utils/notifications` — contains the
 * substring. Without it this walk parses ~2,280 files instead of ~90.
 */
const offenders = testFiles
  .filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return src.includes('notifications') && violationCount(src, f) > 0;
  })
  .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))
  .sort();

describe('the notifications-mock detector itself', () => {
  /**
   * 🔴 POSITIVE CONTROL. A zero from this scan is indistinguishable from a scan wired to
   * nothing, so prove the detector CAN report before reading any count it produces.
   */
  it('reports a wholesale factory', () => {
    const wholesale = `vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));`;
    expect(violationCount(wholesale, 'src/x.browser.test.tsx')).toBe(1);
  });

  /** 🔴 NEGATIVE CONTROL. It must also be able to stay quiet, or it reports everything. */
  it('does not report an importOriginal spread', () => {
    const spread = `vi.mock('~/utils/notifications', async (importOriginal) => ({
      ...(await importOriginal()),
      showErrorNotification: vi.fn(),
    }));`;
    expect(violationCount(spread, 'src/x.browser.test.tsx')).toBe(0);
  });

  /** And it must be pointed at THIS module, not at every mock in the file. */
  it('ignores a wholesale factory for a different module', () => {
    const other = `vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));`;
    expect(violationCount(other, 'src/x.browser.test.tsx')).toBe(0);
  });
});

describe('vi.mock(~/utils/notifications) — the #5102 regression', () => {
  /**
   * The half that is RED at `origin/main` `ba6ce2b835`: on that ref all five of these carry a
   * one-key factory and appear in `offenders`.
   */
  it('keeps the five suites #5102 fixed spreading the real module', () => {
    for (const f of FIXED_BY_5102) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, f)),
        `${f} was moved or deleted — update this list`
      ).toBe(true);
    }
    expect(
      FIXED_BY_5102.filter((f) => offenders.includes(f)),
      'these files broke `preview / component-tests` for ~a day (#5102) because a wholesale ' +
        "`vi.mock('~/utils/notifications', …)` factory omitted `showWarningNotification`, which " +
        'they reach via AppListingDetailBody → AppListingComments → CommentsV2/Comment → ' +
        'BlockUserButton. Spread the original: ' +
        '`async (importOriginal) => ({ ...(await importOriginal<typeof NotificationsModule>()), … })`'
    ).toEqual([]);
  });
});

describe('vi.mock(~/utils/notifications) — the tolerated ledger', () => {
  it('has not grown', () => {
    expect(
      offenders.filter((f) => !TOLERATED.includes(f)),
      "a NEW test wholesale-mocks `~/utils/notifications`. Don't add to the ledger — spread the " +
        'original instead: `async (importOriginal) => ({ ...(await importOriginal<typeof M>()), … })`. ' +
        'A one-key factory fails the WHOLE FILE at import the day anything in its graph imports an ' +
        'export the factory omits, and an import failure collects 0 tests rather than failing one.'
    ).toEqual([]);
  });

  it('has not shrunk silently', () => {
    expect(
      TOLERATED.filter((f) => !offenders.includes(f)),
      'these no longer violate — delete them from TOLERATED in this file so its count stays true ' +
        '(or, if the file was moved/renamed, update the path)'
    ).toEqual([]);
  });
});
