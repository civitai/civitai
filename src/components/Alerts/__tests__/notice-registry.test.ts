import { describe, expect, test } from 'vitest';
import {
  FEATURE_NOTICES,
  FEATURE_NOTICE_IDS,
  isNoticeDismissed,
} from '~/components/Alerts/notice-registry';

// =============================================================================
// The registry, and the dismissed predicate every notice now shares.
//
// SCOPE HONESTY: the id table below is an INVARIANT GUARD, not a regression
// test. No bug ever changed one of these strings; it exists because changing
// one would silently un-dismiss the notice for every user who had dismissed it,
// and nothing else in the codebase would notice. The predicate cases below are
// likewise guards on newly-extracted behaviour, not proof of a fixed defect.
// The refactor's actual behavioural evidence is
// `feature-notice.characterization.browser.test.tsx`, which was written and run
// GREEN against the pre-refactor components before any of this existed.
// =============================================================================

describe('FEATURE_NOTICES', () => {
  // 🔴 Hand-written literals, deliberately not derived from the registry.
  // Deriving them (`Object.values(FEATURE_NOTICES).map(n => n.id)`) would make
  // this table agree with any rename, which is the one thing it must not do.
  // Each string below was copied from the `const ALERT_ID` that lived beside
  // its component before the consolidation.
  const ID_AT_ITS_ORIGINAL_CALL_SITE: Record<keyof typeof FEATURE_NOTICES, string> = {
    navTidy: 'nav-tidy-notice',
    yellowBuzzMigration: 'yellow-buzz-migration',
    cryptoOnrampGuidance: 'crypto-onramp-guidance',
    earnBlueBuzzRewards: 'earn-blue-buzz-rewards',
    remixGalleryExplainer: 'remix-gallery-explainer',
    referralLiteOnboarding: 'referral-lite-onboarding',
    referralKickback: 'referral-kickback-info',
    referralHowItWorks: 'referral-how-it-works',
    referralTokenShop: 'referral-token-shop-info',
  };

  test.each(Object.entries(ID_AT_ITS_ORIGINAL_CALL_SITE))(
    '%s keeps the exact id already persisted in users’ dismissedAlerts: %s',
    (key, expected) => {
      expect(FEATURE_NOTICES[key as keyof typeof FEATURE_NOTICES].id).toBe(expected);
    }
  );

  test('the registry holds exactly the notices this table pins — no silent additions', () => {
    // A new notice must be added to the table above too, which is what forces
    // a human to look at the id string before it reaches production data.
    expect(Object.keys(FEATURE_NOTICES).sort()).toEqual(
      Object.keys(ID_AT_ITS_ORIGINAL_CALL_SITE).sort()
    );
  });

  test('every id is unique — two notices sharing one id would dismiss each other', () => {
    expect(new Set(FEATURE_NOTICE_IDS).size).toBe(FEATURE_NOTICE_IDS.length);
  });

  test('FEATURE_NOTICE_IDS actually enumerates the registry', () => {
    // Positive control on the uniqueness check above: an empty or truncated
    // array would make `new Set(...).size === length` pass vacuously.
    expect(FEATURE_NOTICE_IDS).toHaveLength(Object.keys(FEATURE_NOTICES).length);
    expect(FEATURE_NOTICE_IDS).toContain('nav-tidy-notice');
  });

  test('no id is blank or carries stray whitespace — either would never match a stored value', () => {
    for (const id of FEATURE_NOTICE_IDS) {
      expect(id).not.toBe('');
      expect(id).toBe(id.trim());
    }
  });
});

describe('isNoticeDismissed', () => {
  const notice = FEATURE_NOTICES.navTidy;

  test('true when the id is present', () => {
    expect(isNoticeDismissed(['nav-tidy-notice'], notice)).toBe(true);
  });

  test('true when present among other ids', () => {
    expect(isNoticeDismissed(['a', 'nav-tidy-notice', 'b'], notice)).toBe(true);
  });

  test('false when a DIFFERENT notice is dismissed', () => {
    expect(isNoticeDismissed(['yellow-buzz-migration'], notice)).toBe(false);
  });

  test('false on an empty array', () => {
    expect(isNoticeDismissed([], notice)).toBe(false);
  });

  // 🔴 This is the case the old hand-rolled `(settings?.dismissedAlerts ?? [])`
  // was written for. It answers "false" — NOT DISMISSED — for a settings object
  // that has not resolved, which is indistinguishable from "the user never
  // dismissed it". That is why the predicate alone is not a render gate and
  // `hasSettings` exists; see useFeatureNotice's doc comment.
  test('false when dismissedAlerts is undefined (unresolved settings)', () => {
    expect(isNoticeDismissed(undefined, notice)).toBe(false);
  });

  test('an unknown id in the array does not dismiss anything registered', () => {
    const dismissed = ['some-notice-that-was-never-registered'];
    for (const key of Object.keys(FEATURE_NOTICES) as (keyof typeof FEATURE_NOTICES)[]) {
      expect(isNoticeDismissed(dismissed, FEATURE_NOTICES[key])).toBe(false);
    }
  });

  test('matching is exact, not prefix or substring', () => {
    // `nav-tidy-notice-v2` is what a future replacement notice would be called.
    // If the predicate ever became a `startsWith`/`some(includes)`, dismissing
    // v2 would retroactively dismiss v1 and vice versa.
    expect(isNoticeDismissed(['nav-tidy-notice-v2'], notice)).toBe(false);
    expect(isNoticeDismissed(['tidy'], notice)).toBe(false);
    expect(isNoticeDismissed(['xnav-tidy-notice'], notice)).toBe(false);
  });

  test('reads the notice it is given, not a captured default', () => {
    // Guards against the predicate ignoring its `notice` argument — which would
    // still pass every single-notice case above.
    expect(
      isNoticeDismissed(['crypto-onramp-guidance'], FEATURE_NOTICES.cryptoOnrampGuidance)
    ).toBe(true);
    expect(isNoticeDismissed(['crypto-onramp-guidance'], FEATURE_NOTICES.navTidy)).toBe(false);
  });
});
