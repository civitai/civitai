/**
 * PROVENANCE for a `/apps/activity` "Apps & permissions" row — the discriminator and the
 * two pieces of copy that are computed from it.
 *
 * 🔴 WHY THIS IS A MODULE AND NOT TWO INLINE TERNARIES. The provenance of a row used to be
 * INFERRED on the client from `surfaces`: `buildSurfaceLine` in `src/pages/apps/activity.tsx`
 * pushed 'Granted at consent · no install or subscription' whenever
 * `subscriptionScopes.length === 0 && modelInstallCount === 0`. That inference was sound only
 * while every row came from an install or a consent grant. It no longer is: a row can now be
 * minted from ACTIVITY ALONE — an app that invoked a scope-gated endpoint on the viewer's
 * account with no subscription and no grant row — and such a row also carries `0 / 0`. So the
 * client would have claimed "Granted at consent" about a consent that never happened. The
 * discriminator is therefore SERVER-SIDE (`ScopeGrantSurface.origin`) and the copy branches on
 * it, rather than on a count that two different row classes share.
 *
 * 🔴 DEPENDENCY-FREE LEAF, DELIBERATELY. No React, no Mantine, no tRPC, no Prisma — so the
 * SERVER service can take the `ScopeGrantOrigin` type from here, both CLIENT consumers can take
 * the copy from here, and the behaviour runs in the node-env `unit` project instead of only in
 * the report-only browser tier. Same precedent as `src/shared/constants/block-effective-scopes.ts`
 * (the shared effective-scope rule) and `src/components/Apps/appsActivityTabs.ts` (the pure tab
 * resolver). `blocks.router.ts` reaches `user-app-surface.service` exclusively through
 * `await import(...)`; a shared helper placed in that SERVICE rather than in a leaf would make
 * those lazy imports eager for anything that consumed it.
 */

/**
 * Why a row exists, in PRECEDENCE ORDER (richest first). The service assigns exactly one.
 *
 * 🔴 THE ORDER HERE IS THE PRECEDENCE RULE, AND IT IS LOAD-BEARING RATHER THAN COSMETIC. An app
 * can satisfy more than one of these at once — installed AND consented AND active is the normal
 * shape for a subscribed app that has actually run. The row must report the RICHEST provenance,
 * because that is the one carrying real `modelInstallCount` / `subscriptionScopes` / budget data;
 * reporting 'activity' for an installed app would both understate the relationship and blank the
 * install counts.
 *
 *   · `install`  — the viewer has a `block_user_subscriptions` row (blanket or model-pinned).
 *   · `consent`  — no subscription, but a live (non-revoked) `app_user_scope_grants` row.
 *   · `activity` — NEITHER. The app used the viewer's account anyway: a
 *                  `block_scope_invocations` row.
 *
 * ⚠️ ONLY ONE OF THE THREE DISTINCTIONS IS BEHAVIOUR; THE OTHER IS DOCUMENTATION, AND SAYING SO
 * IS THE POINT. Every read of this field distinguishes ONLY `'activity'`. ⚠️ FOUR SITES, NOT
 * THREE — an earlier revision said three and omitted the server one. Both functions below branch
 * `=== 'activity'`; `src/pages/apps/activity.tsx` reads it twice and
 * `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx` once, all three delegating to those
 * functions; and `src/server/services/blocks/user-app-surface.service.ts` branches on it DIRECTLY
 * (`entry.origin === 'activity'` deciding `scopes: []`), which is the fourth and the one the count
 * missed. NOTHING distinguishes `'install'` from `'consent'` — they
 * return the identical empty-scope label and take the identical path through the surface line,
 * which this module's own suite asserts ("install and consent share one label; activity is the
 * only distinct one"). The pair is kept because it records WHY a row exists for a reader of the
 * server leg and of an API payload, not because any code reads it; do not infer from the
 * three-value ledger that three behaviours exist.
 */
export const SCOPE_GRANT_ORIGINS = ['install', 'consent', 'activity'] as const;

export type ScopeGrantOrigin = (typeof SCOPE_GRANT_ORIGINS)[number];

/**
 * The one-line provenance string under an app's name on the permissions tab.
 *
 * 🔴 THE `activity` BRANCH IS CHECKED FIRST AND IT IGNORES THE COUNTS ENTIRELY. An
 * activity-only row is `0 / 0` by construction (that is what makes it activity-only), so a
 * count-derived branch cannot distinguish it from a consent-only row — which is exactly the bug
 * this discriminator exists to close. Branching on `origin` before looking at a count is what
 * makes the distinction expressible at all.
 */
export function buildScopeGrantSurfaceLine(surfaces: {
  origin: ScopeGrantOrigin;
  modelInstallCount: number;
  subscriptionScopes: string[];
}): string {
  if (surfaces.origin === 'activity') {
    // 🔴 THIS SENTENCE DESCRIBES THE RELATIONSHIP AND ASSERTS NO CONSENT FAILURE, AND THE
    // PREVIOUS ONE DID THE OPPOSITE. It read 'Acted on your account · you never installed or
    // consented to it', which is an accusation, and it was wrong for **100% of the real current
    // population** — enumerated, not sampled, on production 2026-09-12. All six apps behind the
    // 13 invisible pairs are FIRST-PARTY (uid `8753561`); 4 of the 10 viewers are
    // plausibly-public users accounting for 64 of the 111 calls; and EVERY scope involved is in
    // `CONSENT_EXEMPT_SCOPES`, which `scope-grant.service.ts` documents as needing no prompt
    // because read:self covers public data — "nothing sensitive to consent to". Concretely: a
    // viewer opens the first-party `playable-collections`, plays with their OWN collections, it
    // reads them 37 times, and the old line told them an app had acted on their account that
    // they never consented to — with no remedy available, since nothing in the repo writes a
    // non-null `revoked_at`.
    //
    // 🔴 NO SCOPE LIST AND NO SCOPE COUNT — see `scopeGrantEmptyScopeLabel` for the measurement
    // that rules both candidate sets out. And deliberately NOT "it only read data that needs no
    // permission": that is true of today's whole population and would be FALSE the first time a
    // third-party app uses a non-exempt scope, and this function is handed no scope set it could
    // gate the claim on. The weaker sentence that cannot go false is the one that ships.
    return 'Used without an install';
  }
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
    /* The GRANT-ONLY row — a consented full-page app. Reachable since #4790: every row before
       that came from a subscription, seeded with either `modelInstallCount > 0` or one scope,
       so `0 / 0` could not occur. Kept as the `else` of the counts rather than keyed on
       `origin === 'consent'` so an `install`-origin row whose counts somehow both read zero
       still gets a sentence instead of an empty line. */
    parts.push('Granted at consent · no install or subscription');
  }
  return parts.join(' · ');
}

/**
 * What `BlockScopeList` must say for a row whose `scopes` array is EMPTY, per row class.
 *
 * 🔴 THE DEFAULT IS FALSE FOR AN ACTIVITY-ONLY ROW, AND THIS CHANGE MAKES THAT DEFAULT
 * REACHABLE. `BlockScopeList`'s own fallback is "This app doesn't request any permissions — it
 * only consumes data from the host-bridge postMessage protocol." For an app that made
 * scope-gated API calls against this account, that is flatly wrong in the one direction a
 * permissions page must never be wrong in: it tells the viewer an app has no access, on the
 * evidence that it used some. It was filed as an unreachable nit on #4790 because no row could
 * then carry `scopes: []` with a real relationship behind it; the activity-only row does, BY
 * CONSTRUCTION, so the label is passed explicitly at every consumer instead.
 *
 * 🔴 AND `scopes` STAYS EMPTY FOR THIS ROW CLASS — THE FIX IS THE LABEL, NOT A SCOPE LIST.
 * NEITHER CANDIDATE SET IS HONEST, measured on production 2026-09-12 over the 6 apps behind
 * the 13 invisible `(user, app)` pairs, and the two failures point in OPPOSITE directions:
 *
 *   · The DECLARED set over-reports. Four of the six (`app-requests`, `model-benchmarking`,
 *     `sensei`, `gen-matrix`) declare 3–6 scopes and invoked exactly ONE — a 3–6× over-report,
 *     the exact defect class #4790 existed to remove.
 *   · The INVOKED set UNDER-reports as a ceiling and is not even in the vocabulary. Of the 9
 *     distinct `(app, invoked scope)` pairs, FIVE name a scope that is NOT in that app's
 *     `approved_scopes` — and two of those spellings (`apps:storage`, `(any-token)`) appear in
 *     neither `block-scope.constants.ts` nor `SCOPE_DESCRIPTIONS`, so they would render as bare
 *     badges with an italic "(no description)". `w6-ui-dogfood` is the clean counter-example to
 *     a blanket "declared is wider": it declares ONE scope and invoked TWO.
 *
 * So there is no set to show, nothing was granted, and the row's honest content is the
 * RELATIONSHIP — which is what makes this LABEL the whole content rather than a fallback.
 */
export function scopeGrantEmptyScopeLabel(origin: ScopeGrantOrigin): string {
  if (origin === 'activity') {
    // 🔴 REFRAMED FROM AN ACCUSATION TO A DESCRIPTION, BECAUSE THE ACCUSATION WAS FALSE FOR EVERY
    // REAL VIEWER. The previous sentence opened "You never installed this app or consented to it,
    // so you have granted it no permissions" — see `buildScopeGrantSurfaceLine` above for the
    // enumerated population, but the short version is that all six apps are first-party and every
    // scope involved is `CONSENT_EXEMPT`, i.e. one that needs no prompt by design. "You never
    // consented" reads as a consent failure where there was nothing to consent to, and the page
    // offers no remedy for it.
    //
    // 🔴 THE THIRD CLAUSE IS THE WEAK FORM ON PURPOSE. The operator's direction was "It read only
    // data that needs no separate permission", which is TRUE of the entire population measured
    // today and becomes FALSE the first time a third-party app uses a non-exempt scope — and this
    // function receives no scope set it could gate that claim on (the row class deliberately
    // carries `scopes: []`). So the sentence states the general fact that some data needs no
    // grant, WITHOUT claiming that is all this app read. Weaker and unconditionally true, rather
    // than stronger and conditionally false.
    //
    // 🔴 THE FOURTH CLAUSE IS "EVERY API CALL IT MADE", NOT "EVERYTHING IT HAS DONE", AND THAT
    // NARROWING IS A CORRECTION — the absolute was FALSE, on a TRANSPARENCY surface, which is the
    // one place in this change where a wrong sentence is the product rather than a comment about
    // it. `user-app-surface.service.ts` and `src/pages/apps/activity.tsx` both record the reason: a
    // block that consumes the viewer's data purely over the host-bridge postMessage protocol writes
    // NO `block_scope_invocations` row, so Recent activity cannot be the record of EVERYTHING. A
    // reachable row class makes >= 1 scope-gated call (which is what mints this card) and ALSO uses
    // the bridge, and for that class the absolute was plainly wrong. "Every API call it made" is
    // exactly what the invocation table holds, and is unconditionally true of it.
    return 'You have not installed this app, and no separate permission grant is on record for it — some data can be read without one. Every API call it made on your account, with its result, is under Recent activity.';
  }
  // `install` / `consent` with an empty effective set. ⚠️ DELIBERATELY DOES NOT ASSERT WHICH
  // CAUSE: `scopes` is `manifest.scopes ∩ approved_scopes`, and an empty intersection means
  // EITHER the manifest requests nothing (a genuine postMessage-only block — what the
  // component's default asserts) OR the approval snapshot and the current manifest share
  // nothing (a stale-approval skew, see `effectiveBlockScopes`). This read site cannot tell
  // them apart, so the sentence covers both rather than picking the flattering one.
  return 'No permissions are in effect for this app — it either requests none, or none of the ones it requests are currently approved.';
}
