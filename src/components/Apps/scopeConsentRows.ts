/**
 * PHASE 3 — the pure half of the per-scope revoke UI: which rows a permissions surface
 * shows, what CONSENT STATE each one is in, and (for the ones a viewer cannot withdraw)
 * what governs them instead.
 *
 * Deliberately a separate, dependency-free module rather than logic inside either surface.
 * `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx` (the ~408px run-frame drawer)
 * and `src/pages/apps/activity.tsx` (the full-width "Apps & permissions" tab) both render
 * the same list, and the one failure mode this arc has produced over and over is the two
 * drifting — the empty-scope label was corrected on one surface while the other was missed,
 * TWICE, in opposite directions (see `scopeGrantEmptyScopeLabel`, which exists for the same
 * reason). A shared function is what makes "they agree" a fact about the code rather than a
 * promise in a comment.
 *
 * 🔴 THE REVOKABILITY DECISION IS THE SERVER'S AND IS NEVER RE-DERIVED HERE. `revokableScopes`
 * arrives on `ScopeGrantSurface` already computed as
 * `consentGatedScopes(displayedScopes).filter(isKnownBlockScope)` — i.e. from the SAME
 * `CONSENT_EXEMPT_SCOPES` set the MINT consults in `partitionByConsent`. A client-side copy of
 * that set would drift silently and in the dangerous direction: a scope the client believed
 * gated gets a button, `blocks.revokeScopes` stores a suppression `partitionByConsent` never
 * reads, and the UI reports success while the app keeps the permission. So this module only
 * ever ASKS whether a scope is in the server's list; it never decides.
 *
 * ⚠️ `FIXED_SCOPE_NOTES` BELOW IS KEYED BY SCOPE ID AND IS THEREFORE A CLIENT-SIDE COPY OF
 * SOMETHING — but of the PROSE, not of the decision, and the distinction is what makes it safe.
 * It is consulted ONLY for a scope the server has already excluded from `revokableScopes`. If
 * the exempt set ever shrinks, that scope appears in `revokableScopes`, gets a real control,
 * and this map is never reached for it; if the set ever GROWS, the new member correctly loses
 * its control and falls back to `fixedScopeNote`'s generic sentence. Both directions degrade to
 * "correct control, less specific prose" rather than to a lie.
 */

/**
 * The consent state of one displayed scope row.
 *
 *   - `revokable` — the viewer may withdraw it, and a control is offered.
 *   - `revoked`   — the viewer HAS withdrawn it. Still rendered, marked, never dropped.
 *   - `fixed`     — it is signed without reference to the viewer's consent, so there is
 *                   nothing to withdraw. Rendered with an honest note, NOT a disabled
 *                   button and NOT silence.
 *
 * ⚠️ `fixed` IS NOT A SYNONYM FOR "CONSENT-EXEMPT", and naming it after the exempt set would
 * have made it one. It is the residual: a displayed scope that is neither revoked nor in the
 * server's `revokableScopes`. The seven `CONSENT_EXEMPT_SCOPES` members are the dominant
 * population, but an UNKNOWN scope id reaches it too — `revokableScopes` filters on
 * `isKnownBlockScope`, and `blocks.revokeScopes` rejects an unknown string outright, so
 * offering a control for one would produce a `BAD_REQUEST` the viewer cannot act on.
 */
export type ScopeConsentState = 'revokable' | 'revoked' | 'fixed';

export type ScopeConsentRow = {
  scope: string;
  state: ScopeConsentState;
};

/**
 * The displayed rows for one app, in render order, each tagged with its consent state.
 *
 * 🔴 A REVOKED SCOPE IS APPENDED EVEN WHEN IT IS NOT IN `scopes`, AND THAT IS THE WHOLE
 * REASON THIS FUNCTION EXISTS RATHER THAN A `.map()` AT EACH CALL SITE. `scopes` is the
 * APP-SIDE set (`manifest.scopes ∩ approved_scopes`) and `revokedScopes` is a USER-SIDE
 * one; `ScopeGrantSurface`'s own docblocks state that the user-side sets are NOT subsets of
 * `scopes`, because a publisher push replaces `manifest` without re-approval. So a viewer
 * can withdraw a permission and then have the app drop that scope in its next version — at
 * which point a surface that rendered `scopes` alone would silently FORGET the withdrawal.
 * A permissions page that forgets what you withdrew is worse than one that never had the
 * control, so the row survives its own disappearance from the manifest.
 *
 * Order: the app's own set first, in the order the server sent it (manifest order,
 * de-duplicated), then any revoked-but-no-longer-declared scope, sorted. Appending rather
 * than merging keeps the common case byte-identical to the pre-change list, so the phase-1
 * geometry arms — which read the gap from the FIRST fixture scope's description down to the
 * SECOND's id — are measuring the same two rows they were written against.
 *
 * 🔴 THE STATE TESTS ARE ORDERED `revoked` → `revokable` → `fixed`, AND THE FIRST TWO CANNOT
 * BE SWAPPED. `revokedScopes` and `revokableScopes` OVERLAP by construction: `revokableScopes`
 * is computed from `displayedScopes` with no reference to what has been withdrawn, so a scope
 * the viewer just revoked is still in it — that is correct for the server (re-consent then
 * re-revoke must both be possible) and wrong for a row, which has one state. Testing
 * `revokable` first would render a live "Remove" button on a permission already gone and never
 * show the revoked marker at all.
 */
export function buildScopeConsentRows({
  scopes,
  revokedScopes,
  revokableScopes,
}: {
  scopes: string[];
  revokedScopes: string[];
  revokableScopes: string[];
}): ScopeConsentRow[] {
  const revoked = new Set(revokedScopes);
  const revokable = new Set(revokableScopes);
  const state = (scope: string): ScopeConsentState =>
    revoked.has(scope) ? 'revoked' : revokable.has(scope) ? 'revokable' : 'fixed';

  const displayed = new Set(scopes);
  const rows: ScopeConsentRow[] = scopes.map((scope) => ({ scope, state: state(scope) }));
  // `.sort()` on a fresh filtered array — never on `revokedScopes` itself, which is the
  // caller's (and ultimately react-query's cached) array. The server already sorts it; this
  // makes the order of the APPENDED tail independent of that promise.
  for (const scope of revokedScopes.filter((s) => !displayed.has(s)).sort()) {
    rows.push({ scope, state: 'revoked' });
  }
  return rows;
}

/**
 * What governs each `CONSENT_EXEMPT_SCOPES` member INSTEAD of the viewer's consent.
 *
 * 🔴 EVERY SENTENCE HERE IS A CLAIM ABOUT A SERVER-SIDE GATE AND IS SOURCED FROM THAT GATE'S
 * OWN COMMENT in `src/server/services/blocks/scope-grant.service.ts`'s `CONSENT_EXEMPT_SCOPES`
 * declaration — shared storage is "resolveSharedContext's server-side min-trust gate + content
 * moderation + rate limits"; collections are "server-side visibility/ownership (read) +
 * self-bound subject (follow)". Do not soften one into a vaguer reassurance and do not invent a
 * mechanism for one that has none: an unsourced sentence here is exactly the shape that got
 * five successive wordings of `BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY` shipped false.
 *
 * ⚠️ NONE OF THESE SAYS "UNINSTALL THE APP TO END IT", and that omission is deliberate. The
 * exemption is applied at the MINT, before the grant is consulted, so an uninstall does not
 * stop an exempt scope reaching `claims.scopes` — pointing a viewer at the Installs tab here
 * would repeat the exact false instruction the /apps/activity copy was corrected for.
 */
export const FIXED_SCOPE_NOTES: Record<string, string> = {
  'apps:storage:read':
    "Can't be withdrawn. It reaches only this app's own private store for your data — the " +
    'store exists for the app and is bounded to it, so there is no separate permission to take ' +
    'back.',
  'apps:storage:write':
    "Can't be withdrawn. It writes only to this app's own private store for your data, which " +
    'is bounded to that app rather than to anything else on your account.',
  'apps:storage:shared:read':
    "Can't be withdrawn. Cross-user app data is gated server-side on every request instead — a " +
    'minimum account-trust check, content moderation, and rate limits.',
  'apps:storage:shared:write':
    "Can't be withdrawn. Cross-user app data is gated server-side on every request instead — a " +
    'minimum account-trust check, content moderation, and rate limits.',
  'models:read:self':
    "Can't be withdrawn. It reads only the model on the page the app is mounted on, which is " +
    'the page you opened — the subject is fixed by where the app runs, not by a permission.',
  'collections:read:self':
    "Can't be withdrawn. Every read is checked server-side against the collection's own " +
    'visibility and ownership, so it can reach nothing you could not already see.',
  'collections:write:self':
    "Can't be withdrawn. The action is bound server-side to your own account as the subject, " +
    'so it can only bookmark on your behalf and cannot reach anyone else.',
};

/**
 * The note for a `fixed` row — a specific sentence where we have one, an honest generic
 * otherwise.
 *
 * 🔴 THE FALLBACK IS NOT DECORATION; IT IS THE ONLY BRANCH THAT CAN SERVE THE `fixed` STATE'S
 * OTHER POPULATION. An UNKNOWN scope id is `fixed` too (see `ScopeConsentState`), and it has no
 * entry here by definition — a `FIXED_SCOPE_NOTES[scope]` read with no fallback would render
 * `undefined`, i.e. an unexplained row with no control, which is the "silence" the brief for
 * this phase rules out. It also covers the exempt set GROWING server-side without this map
 * being updated, which is the drift direction that degrades safely.
 */
export function fixedScopeNote(scope: string): string {
  return (
    FIXED_SCOPE_NOTES[scope] ??
    "Can't be withdrawn here. This permission is granted by platform policy rather than by " +
      'your consent, and is bounded by server-side checks on every request instead.'
  );
}
