import { describe, expect, test } from 'vitest';
import type { FeatureNotice } from '~/components/Alerts/notice-registry';
import {
  FEATURE_NOTICES,
  FEATURE_NOTICE_IDS,
  isNoticeAudienceMatched,
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
    navCustomize: 'nav-customize-notice',
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
    expect(FEATURE_NOTICE_IDS).toContain('nav-customize-notice');
  });

  test('no id is blank or carries stray whitespace — either would never match a stored value', () => {
    for (const id of FEATURE_NOTICE_IDS) {
      expect(id).not.toBe('');
      expect(id).toBe(id.trim());
    }
  });
});

describe('isNoticeDismissed', () => {
  const notice = FEATURE_NOTICES.navCustomize;

  test('true when the id is present', () => {
    expect(isNoticeDismissed(['nav-customize-notice'], notice)).toBe(true);
  });

  test('true when present among other ids', () => {
    expect(isNoticeDismissed(['a', 'nav-customize-notice', 'b'], notice)).toBe(true);
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
    // `nav-customize-notice-v2` is what a future replacement notice would be called.
    // If the predicate ever became a `startsWith`/`some(includes)`, dismissing
    // v2 would retroactively dismiss v1 and vice versa.
    expect(isNoticeDismissed(['nav-customize-notice-v2'], notice)).toBe(false);
    expect(isNoticeDismissed(['tidy'], notice)).toBe(false);
    expect(isNoticeDismissed(['xnav-customize-notice'], notice)).toBe(false);
  });

  test('reads the notice it is given, not a captured default', () => {
    // Guards against the predicate ignoring its `notice` argument — which would
    // still pass every single-notice case above.
    expect(
      isNoticeDismissed(['crypto-onramp-guidance'], FEATURE_NOTICES.cryptoOnrampGuidance)
    ).toBe(true);
    expect(isNoticeDismissed(['crypto-onramp-guidance'], FEATURE_NOTICES.navCustomize)).toBe(false);
  });
});

// =============================================================================
// AUDIENCE TARGETING — the returned-value half.
//
// This is the gate itself, as a pure function, so the blocking `unit` project
// can execute it. The hook that consumes it is covered by
// `useFeatureNotice.audience.test.ts` (also `unit`, via happy-dom), and the
// rendered component by `notice-callsite.browser.test.tsx` (project
// `component`, which CI does NOT run). All three assert behaviour; none of them
// asserts that the field exists.
//
// Fixtures name flags that are NOT `remixGallery`, the only audience the
// registry currently declares — a fixture that could only ever produce the
// production value cannot catch a mutant that hardcodes the production value.
// The two targeted fixtures name DIFFERENT flags and are given DIFFERENT
// answers, so "reads its own audience" is separable from "some flag was on".
// =============================================================================

describe('isNoticeAudienceMatched', () => {
  const targetedAlpha: FeatureNotice = {
    id: 'fixture-audience-alpha',
    audience: { feature: 'imageCardInfoButton' },
  };
  const targetedBeta: FeatureNotice = {
    id: 'fixture-audience-beta',
    audience: { feature: 'appReviewPage' },
  };
  const untargeted: FeatureNotice = { id: 'fixture-audience-gamma' };

  /** Alpha's flag on, beta's off — one map, two opposite answers. */
  const flags = { imageCardInfoButton: true, appReviewPage: false };

  describe('a notice with no audience', () => {
    // 🔴 INVARIANT guards: they pin that the eight untargeted notices are
    // unaffected by targeting existing. They pass with the audience branch
    // deleted, by design, so they are not the mutation evidence.
    test('matches even when every flag is off', () => {
      expect(isNoticeAudienceMatched(untargeted, { imageCardInfoButton: false }, true)).toBe(true);
    });

    test('matches before the flag overlay is ready', () => {
      expect(isNoticeAudienceMatched(untargeted, flags, false)).toBe(true);
    });

    test('matches with no flags at all', () => {
      expect(isNoticeAudienceMatched(untargeted, null, true)).toBe(true);
      expect(isNoticeAudienceMatched(untargeted, undefined, true)).toBe(true);
    });
  });

  describe('a notice with an audience', () => {
    test('matches a user its own flag is on for', () => {
      expect(isNoticeAudienceMatched(targetedAlpha, flags, true)).toBe(true);
    });

    test('does NOT match a user its own flag is off for', () => {
      expect(isNoticeAudienceMatched(targetedBeta, flags, true)).toBe(false);
    });

    test('reads ITS OWN flag, not whichever flag happens to be on', () => {
      // Same map, same readiness, opposite results. A body that ignored
      // `audience.feature` could not produce both.
      expect(isNoticeAudienceMatched(targetedAlpha, flags, true)).toBe(true);
      expect(isNoticeAudienceMatched(targetedBeta, flags, true)).toBe(false);
      // …and swapping the answers swaps the results, so neither is a constant.
      const swapped = { imageCardInfoButton: false, appReviewPage: true };
      expect(isNoticeAudienceMatched(targetedAlpha, swapped, true)).toBe(false);
      expect(isNoticeAudienceMatched(targetedBeta, swapped, true)).toBe(true);
    });

    test('a flag missing from the overlay is not membership', () => {
      // Absent is not the same as false, and must not read as "in".
      expect(isNoticeAudienceMatched(targetedAlpha, {}, true)).toBe(false);
    });

    test('fails closed before the per-user overlay resolves', () => {
      // The map here says the user IS in the audience; readiness is what
      // withholds it. Announcing against the anonymous snapshot and retracting
      // is the flash this exists to avoid.
      expect(isNoticeAudienceMatched(targetedAlpha, flags, false)).toBe(false);
    });

    test('fails closed with no flags at all', () => {
      expect(isNoticeAudienceMatched(targetedAlpha, null, true)).toBe(false);
      expect(isNoticeAudienceMatched(targetedAlpha, undefined, true)).toBe(false);
    });

    test('a non-boolean-true value is not membership', () => {
      // The overlay is `Record<key, boolean>`, but it is assembled server-side
      // and merged with an SSR snapshot; a truthy non-`true` must not pass.
      const dirty = { imageCardInfoButton: 'yes' } as unknown as Record<string, boolean>;
      expect(isNoticeAudienceMatched(targetedAlpha, dirty, true)).toBe(false);
    });
  });
});
