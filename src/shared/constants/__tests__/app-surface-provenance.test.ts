import { describe, expect, it } from 'vitest';
import {
  SCOPE_GRANT_ORIGINS,
  buildScopeGrantSurfaceLine,
  scopeGrantEmptyScopeLabel,
  type ScopeGrantOrigin,
} from '~/shared/constants/app-surface-provenance';

/**
 * THE TWO COMPUTED COPY SITES of the `/apps/activity` permissions tab.
 *
 * 🔴 WHY THIS SUITE EXISTS IN THE NODE-ENV `unit` PROJECT. Both strings were previously
 * produced inside `src/pages/apps/activity.tsx`, whose only coverage tier is
 * `*.browser.test.tsx` — report-only, and unrunnable without a Playwright binary. That file's own
 * comment recorded the consequence: the provenance line is "the one copy site a literal sweep
 * cannot find — it is computed". A computed copy site needs a BEHAVIOURAL test, so the rule moved
 * to a React-free leaf and the behaviour is pinned here.
 */

describe('buildScopeGrantSurfaceLine', () => {
  /**
   * 🔴 THE DEFECT, CHARACTERISED FROM THE BASE IMPLEMENTATION RATHER THAN DESCRIBED.
   *
   * This is `buildSurfaceLine` as it stood at `origin/main` — copied verbatim from
   * `src/pages/apps/activity.tsx` (the `parts` construction, the two `if`s and the `0/0`
   * `else if`), with only its name changed. It takes no `origin`, because there was none.
   *
   * Pinning it here is the honest way to show the bug: the function itself was never exported,
   * so no red-at-base test could call it, and "the old copy was wrong" is otherwise a claim with
   * no witness. The assertion below is that the BASE rule returns the WRONG sentence for an
   * activity-only row — and it does so for a structural reason, not a typo: an activity-only row
   * is `0 / 0`, which is the exact input its consent branch fires on.
   */
  function baseImplementation(surfaces: {
    modelInstallCount: number;
    subscriptionScopes: string[];
  }): string {
    const parts: string[] = [];
    if (surfaces.modelInstallCount > 0) {
      parts.push(
        `${surfaces.modelInstallCount} model install${surfaces.modelInstallCount === 1 ? '' : 's'}`
      );
    }
    if (surfaces.subscriptionScopes.length > 0) {
      parts.push(
        `Subscriptions: ${surfaces.subscriptionScopes
          .map((s) => (s === 'publisher_all_my_models' ? 'publisher' : 'viewer'))
          .join(' / ')}`
      );
    } else if (surfaces.modelInstallCount === 0) {
      parts.push('Granted at consent · no install or subscription');
    }
    return parts.join(' · ');
  }

  const ACTIVITY_ONLY = {
    origin: 'activity' as const,
    modelInstallCount: 0,
    subscriptionScopes: [] as string[],
  };

  it('🔴 the BASE rule mislabels an activity-only row as "Granted at consent"', () => {
    // The premise: the two row classes are indistinguishable by counts.
    const { modelInstallCount, subscriptionScopes } = ACTIVITY_ONLY;
    expect(baseImplementation({ modelInstallCount, subscriptionScopes })).toBe(
      'Granted at consent · no install or subscription'
    );
    // …and a consent-only row produces the IDENTICAL string from the IDENTICAL input, which is
    // what makes the count-derived inference unfixable rather than merely wrong.
    expect(baseImplementation({ modelInstallCount: 0, subscriptionScopes: [] })).toBe(
      baseImplementation({ modelInstallCount, subscriptionScopes })
    );
  });

  /**
   * 🔴 THE LINE DESCRIBES THE RELATIONSHIP AND ALLEGES NOTHING. Pinned as the WHOLE normalised
   * string, plus the two things it must never say, because a keyword guard here is walkable by
   * rewording: the previous line ('Acted on your account · you never installed or consented to
   * it') would satisfy any check for "install" or "consent".
   */
  it('🔴 names the relationship without asserting a consent failure', () => {
    const line = buildScopeGrantSurfaceLine(ACTIVITY_ONLY);
    expect(line).toBe('Used without an install');
    // The falsehood the discriminator exists to prevent.
    expect(line).not.toContain('Granted at consent');
    // 🔴 AND THE ACCUSATION THE PREVIOUS LINE MADE. Measured on production 2026-09-12 over the
    // complete population: all six apps are first-party, and every scope involved is in
    // `CONSENT_EXEMPT_SCOPES`, i.e. one that needs no prompt by design — so "you never consented"
    // named a failure that did not occur, for 100% of real viewers, with no remedy on offer.
    expect(line).not.toContain('never');
    expect(line).not.toContain('consent');
  });

  it('a CONSENT row keeps the consent sentence', () => {
    expect(
      buildScopeGrantSurfaceLine({
        origin: 'consent',
        modelInstallCount: 0,
        subscriptionScopes: [],
      })
    ).toBe('Granted at consent · no install or subscription');
  });

  /**
   * 🔴 THE ORIGIN BRANCH MUST WIN OVER THE COUNTS, NOT MERELY BE CONSULTED. The fixture gives an
   * `activity` row NON-ZERO counts — a state the service cannot currently produce, and that is
   * the point: it is the only input on which "branch on origin first" and "branch on origin only
   * when the counts are 0/0" give different answers. A mutant that checked `origin === 'activity'
   * && modelInstallCount === 0` passes every other test in this file and fails this one.
   */
  it('🔴 an activity origin ignores the counts entirely', () => {
    expect(
      buildScopeGrantSurfaceLine({
        origin: 'activity',
        modelInstallCount: 4,
        subscriptionScopes: ['viewer_personal'],
      })
    ).toBe('Used without an install');
  });

  // ── The pre-existing install/consent behaviour, unchanged and pinned so the move is a move.
  it('renders a singular model install', () => {
    expect(
      buildScopeGrantSurfaceLine({
        origin: 'install',
        modelInstallCount: 1,
        subscriptionScopes: [],
      })
    ).toBe('1 model install');
  });

  it('renders plural installs plus both subscription scopes, mapped to friendly words', () => {
    expect(
      buildScopeGrantSurfaceLine({
        origin: 'install',
        modelInstallCount: 3,
        subscriptionScopes: ['publisher_all_my_models', 'viewer_personal'],
      })
    ).toBe('3 model installs · Subscriptions: publisher / viewer');
  });

  it('an unknown subscription scope maps to "viewer", matching the pre-move rule', () => {
    expect(
      buildScopeGrantSurfaceLine({
        origin: 'install',
        modelInstallCount: 0,
        subscriptionScopes: ['something_new'],
      })
    ).toBe('Subscriptions: viewer');
  });

  /**
   * IDENTITY-OF-BEHAVIOUR PIN FOR THE MOVE. Derived by CALLING the base implementation above
   * rather than hand-copying its outputs, because a "these two agree" guard written as a literal
   * on each side pins nothing — tighten one and its own literal and both stay green while the
   * two have diverged. Every case here is an install/consent row, i.e. exactly the domain on
   * which the move must be behaviour-preserving.
   */
  it('is byte-identical to the base rule on every non-activity input (derived, not copied)', () => {
    const cases = [
      { modelInstallCount: 0, subscriptionScopes: [] },
      { modelInstallCount: 1, subscriptionScopes: [] },
      { modelInstallCount: 7, subscriptionScopes: ['viewer_personal'] },
      { modelInstallCount: 0, subscriptionScopes: ['publisher_all_my_models'] },
      {
        modelInstallCount: 2,
        subscriptionScopes: ['publisher_all_my_models', 'viewer_personal'],
      },
    ];
    // Guard the guard: a base implementation that returned '' for everything would make this
    // comparison vacuous.
    expect(new Set(cases.map((c) => baseImplementation(c))).size).toBe(cases.length);
    for (const origin of ['install', 'consent'] as const) {
      for (const c of cases) {
        expect(buildScopeGrantSurfaceLine({ origin, ...c })).toBe(baseImplementation(c));
      }
    }
  });

  it('never returns an empty string for any origin', () => {
    for (const origin of SCOPE_GRANT_ORIGINS) {
      expect(
        buildScopeGrantSurfaceLine({ origin, modelInstallCount: 0, subscriptionScopes: [] }).length
      ).toBeGreaterThan(0);
    }
  });
});

describe('scopeGrantEmptyScopeLabel', () => {
  /** `BlockScopeList`'s own default — the string that must NOT reach an activity-only row. */
  const COMPONENT_DEFAULT =
    "This app doesn't request any permissions — it only consumes data from the host-bridge postMessage protocol.";

  /**
   * 🔴 THE REACHABLE-AND-WRONG DEFAULT. `src/pages/apps/activity.tsx` rendered
   * `<BlockScopeList scopes={grant.scopes} />` with no `emptyLabel`, so an empty array fell
   * through to the component's default above. That was filed as an unreachable nit on #4790,
   * because while every row came from an install or a consent no row could carry `scopes: []`
   * with a real relationship behind it. An activity-only row does, BY CONSTRUCTION — so the
   * default became reachable AND is false in the one direction a permissions page must never be
   * false in: it tells the viewer an app has no access, on the evidence that it used some.
   */
  it('🔴 the activity label contradicts the component default rather than restating it', () => {
    const label = scopeGrantEmptyScopeLabel('activity');
    expect(label).not.toBe(COMPONENT_DEFAULT);
    expect(label).not.toContain("doesn't request any permissions");
    expect(label).not.toContain('postMessage');
    // It must say the two things that ARE true of this row class: there is no install and no
    // grant on record, and the record of what happened is elsewhere.
    expect(label).toContain('not installed this app');
    expect(label).toContain('no separate permission grant is on record');
    expect(label).toContain('Recent activity');
  });

  /**
   * 🔴 THE WHOLE NORMALISED STRING, AND THE TWO CLAIMS IT MUST NOT MAKE. This is the copy the
   * operator's decision turned around, so it is pinned byte-for-byte rather than by keyword — a
   * cosmetic reword failing this test is the price of a machine-readable claim.
   *
   * Claim 1 it must not make: a CONSENT FAILURE. The previous label opened "You never installed
   * this app or consented to it". Measured on production 2026-09-12 over the complete population
   * (not sampled): all six apps are FIRST-PARTY, 4 of the 10 viewers are plausibly-public users
   * accounting for 64 of the 111 calls, and EVERY scope involved is in `CONSENT_EXEMPT_SCOPES` —
   * which `scope-grant.service.ts` documents as needing no prompt because read:self covers public
   * data. So the sentence alleged a failure that had not occurred for 100% of real viewers, and
   * offered no remedy (nothing writes a non-null `revoked_at`).
   *
   * Claim 2 it must not make: "it read ONLY data that needs no separate permission". That is the
   * operator's stated direction and it is TRUE of today's whole population, but this function is
   * handed no scope set, so the claim cannot be gated and would go FALSE the first time a
   * third-party app uses a non-exempt scope. The shipped sentence states the general fact that
   * some data needs no grant without claiming that is all this app read.
   *
   * Claim 3 it must not make, and the one the PINNED STRING CHANGED FOR: "EVERYTHING it has done …
   * is under Recent activity". That absolute was false and false on a transparency surface. A block
   * consuming the viewer's data purely over the host-bridge postMessage protocol writes NO
   * `block_scope_invocations` row — stated in this same change at
   * `src/pages/apps/activity.tsx` — and a reachable row class makes >= 1 scope-gated call (which is
   * what mints this card) and ALSO uses the bridge. "Every API call it made" is exactly the
   * invocation table's contents, so it is the strongest true form. The `not.toContain('Everything
   * it has done')` below is the pin that stops the absolute coming back by reword.
   */
  it('🔴 the activity label, pinned whole: no consent failure, no unconditional "only" claim', () => {
    expect(scopeGrantEmptyScopeLabel('activity')).toBe(
      'You have not installed this app, and no separate permission grant is on record for it — some data can be read without one. Every API call it made on your account, with its result, is under Recent activity.'
    );
    // 🔴 THE OVER-CLAIM THIS STRING REPLACED, pinned so a reword cannot reintroduce it: the page
    // cannot promise a record of EVERYTHING an app did, only of every API call it made.
    expect(scopeGrantEmptyScopeLabel('activity')).not.toContain('Everything it has done');
    const label = scopeGrantEmptyScopeLabel('activity');
    expect(label).not.toContain('never');
    expect(label).not.toContain('consent');
    expect(label).not.toContain('only data');
    expect(label).not.toContain('read only');
  });

  /**
   * 🔴 THE INSTALL/CONSENT LABEL MUST NOT CLAIM THE VIEWER NEVER INSTALLED OR CONSENTED. That is
   * what the drawer's previous hard-coded string did ("No permissions recorded from an install or
   * consent for this app"), and it is false for a row that came from exactly one of those with an
   * empty effective set.
   */
  it('🔴 the install/consent label does not deny the install or the consent', () => {
    for (const origin of ['install', 'consent'] as const) {
      const label = scopeGrantEmptyScopeLabel(origin);
      expect(label).not.toContain('never installed');
      expect(label).not.toContain('no install or consent');
      // Tracks the activity label's CURRENT wording, not a retired one: the clause below is the
      // half of that label which denies an install, so this is the assertion that stays meaningful
      // if the activity copy is reworded again. (`granted it no permissions` was the phrase here
      // before the reframe; it no longer appears in either label, so asserting its absence had
      // quietly become vacuous.)
      expect(label).not.toContain('not installed this app');
    }
  });

  /**
   * ⚠️ AND IT MUST NOT ASSERT A CAUSE IT CANNOT KNOW. `scopes` is `manifest ∩ approved`, so an
   * empty set means EITHER the manifest requests nothing (a genuine postMessage-only block) OR
   * the approval snapshot and the current manifest share nothing (stale-approval skew). This read
   * site cannot tell them apart; the sentence must cover both. Pinned as a WHOLE-STRING equality
   * rather than a keyword check, because a guard on words is walkable by rewording — a cosmetic
   * reword will fail this test, which is the price of a machine-readable claim.
   */
  it('🔴 the install/consent label names BOTH causes of an empty effective set', () => {
    expect(scopeGrantEmptyScopeLabel('install')).toBe(
      'No permissions are in effect for this app — it either requests none, or none of the ones it requests are currently approved.'
    );
  });

  /**
   * ⚠️ THE LEDGER HAS THREE VALUES AND TWO BEHAVIOURS, AND THIS IS WHERE THAT IS RECORDED
   * MECHANICALLY. `install` vs `consent` changes NOTHING — not this label, not the surface line,
   * and not any of the FOUR sites that read the field (⚠️ four, not the three an earlier revision
   * counted: `src/pages/apps/activity.tsx` ×2, `AppPermissionsActivityDrawer` ×1, and
   * `src/server/services/blocks/user-app-surface.service.ts`'s own `entry.origin === 'activity'`
   * deciding `scopes: []`), every one of which distinguishes ONLY `'activity'`. The pair is
   * kept as documentation of WHY a row exists for a reader of the server leg and of the API
   * payload; it is not something the code acts on, and the enum's size must not be read as
   * evidence that it is.
   */
  it('install and consent are behaviourally IDENTICAL; activity is the only distinct one', () => {
    expect(scopeGrantEmptyScopeLabel('install')).toBe(scopeGrantEmptyScopeLabel('consent'));
    expect(scopeGrantEmptyScopeLabel('activity')).not.toBe(scopeGrantEmptyScopeLabel('install'));
    // The surface line too, across inputs that exercise every branch of the counts arm — so the
    // claim is about the function, not about one lucky fixture.
    for (const c of [
      { modelInstallCount: 0, subscriptionScopes: [] as string[] },
      { modelInstallCount: 1, subscriptionScopes: [] as string[] },
      { modelInstallCount: 2, subscriptionScopes: ['viewer_personal'] },
      { modelInstallCount: 0, subscriptionScopes: ['publisher_all_my_models'] },
    ]) {
      expect(buildScopeGrantSurfaceLine({ origin: 'install', ...c })).toBe(
        buildScopeGrantSurfaceLine({ origin: 'consent', ...c })
      );
    }
  });

  it('every origin in the ledger gets a non-empty label', () => {
    for (const origin of SCOPE_GRANT_ORIGINS) {
      expect(scopeGrantEmptyScopeLabel(origin).length).toBeGreaterThan(0);
    }
  });

  /**
   * A GROWTH-AND-SHRINK LEDGER on the origin set itself, in the shape this repo already uses
   * (`block-effective-scopes.call-sites.test.ts`, `app-access.call-site-ledger.test.ts`). A new
   * origin must be added here consciously — and, because both functions above are exhaustive
   * over it, whoever adds one has to decide what each says rather than inherit a branch by
   * accident.
   */
  it('the origin ledger is exactly install / consent / activity, in precedence order', () => {
    expect(SCOPE_GRANT_ORIGINS).toEqual(['install', 'consent', 'activity']);
    // The type and the runtime array cannot drift: this assignment stops compiling if they do.
    const every: ScopeGrantOrigin[] = [...SCOPE_GRANT_ORIGINS];
    expect(every).toHaveLength(3);
  });
});
