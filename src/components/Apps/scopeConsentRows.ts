import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';

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
 * its control and falls back to `fixedScopeNote`'s generic sentence.
 *
 * ⚠️ THE NEXT SENTENCE USED TO CLAIM *"Both directions degrade to 'correct control, less specific
 * prose' rather than to a lie."* THAT IS RETRACTED — the generic fallback WAS a lie for one of
 * the two populations `fixed` covers. An UNKNOWN scope id is `fixed` too, and for it the generic
 * sentence ("granted by platform policy … bounded by server-side checks on every request") is
 * false in both halves: a retired id is granted by nothing and enforced by nothing. That is not
 * hypothetical — `listMyScopeGrants` documents `block:settings:read`/`write` and
 * `media:read:owned` as retired from the registry yet still present in some apps' `manifest.scopes`
 * AND `approved_scopes`, so they reach the rendered list. `fixedScopeNote` now branches on
 * `isKnownBlockScope` and says what is true of that arm instead. Found by the correctness-review
 * lane; the CONTROL was always correct, only the prose was wrong.
 */

/**
 * The consent state of one displayed scope row.
 *
 *   - `revokable`   — the viewer may withdraw it, and a control is offered.
 *   - `revoked`     — the viewer HAS withdrawn it. Still rendered, marked, never dropped.
 *   - `withheld`    — the viewer DID agree to it and the whole grant is on hold (`revoked_at`),
 *                     so it conveys nothing until they confirm the app's permissions again.
 *                     Distinct from all four below it: `revoked` says the VIEWER withdrew it,
 *                     `not-granted` says they never gave it, `fixed` says the platform granted it
 *                     and enforces it server-side, and `unknown` is silence about a fact we know.
 *   - `not-granted` — the APP declares it and the viewer never agreed to it, so there is
 *                     nothing to withdraw YET. A control here would offer an action the server
 *                     now refuses.
 *   - `fixed`       — it is signed without reference to the viewer's consent, so there is
 *                     nothing to withdraw. Rendered with an honest note, NOT a disabled
 *                     button and NOT silence.
 *   - `unknown`     — THE SERVER DID NOT TELL US. Distinct from `fixed`, and conflating the two
 *                     was a real defect: `revokableScopes` ABSENT is not `revokableScopes` EMPTY.
 *                     Rendered with NO affordance and NO note, because the only honest thing to
 *                     say is nothing.
 *
 * 🔴 WHY `not-granted` IS ITS OWN STATE RATHER THAN A NARROWER `revokableScopes`. The obvious
 * spelling is to intersect `revokableScopes` with the granted set server-side, and it is wrong:
 * a scope that fell out of `revokableScopes` lands in `fixed`, whose note says the permission is
 * *"granted by platform policy rather than by your consent, and is bounded by server-side checks
 * on every request instead"*. For a scope the viewer simply never agreed to, both halves are
 * false — nothing granted it and nothing is enforcing it — and it is the same
 * correct-control/false-copy combination this type's `unknown` state was introduced to stop.
 * So the server keeps reporting the CONSENT-GATED set and the viewer's granted set separately,
 * and the split happens here where both are in hand.
 *
 * 🔴 WHY `unknown` EXISTS RATHER THAN `?? []`. `ScopeConsentList` used to coalesce a missing
 * `revokableScopes` to `[]`, which made EVERY row `fixed` — so a genuinely withdrawable
 * `ai:write:budgeted` rendered "Can't be withdrawn … granted by platform policy", a false claim
 * about the viewer's own consent on the consent surface. It is fail-closed for the ACTION and
 * fail-OPEN for the COPY, which is the combination that reads as correct while lying.
 * ⚠️ AND THE TRIGGER IS NOT THE ONE FIRST WRITTEN DOWN. That comment blamed a tab held open
 * across the deploy at `staleTime: Infinity`; the correctness-review lane pointed out an old tab
 * runs the OLD BUNDLE, where this component does not exist, so that path cannot produce it. The
 * reachable trigger is the MIXED-VERSION WINDOW during a rollout: a new bundle querying a pod
 * still on pre-phase-2 server code gets rows without the three new fields.
 *
 * ⚠️ `fixed` IS NOT A SYNONYM FOR "CONSENT-EXEMPT", and naming it after the exempt set would
 * have made it one. It is the residual: a displayed scope that is neither revoked nor in the
 * server's `revokableScopes`. The `CONSENT_EXEMPT_SCOPES` members are the dominant
 * population, but an UNKNOWN scope id reaches it too — `revokableScopes` filters on
 * `isKnownBlockScope`, and `blocks.revokeScopes` rejects an unknown string outright, so
 * offering a control for one would produce a `BAD_REQUEST` the viewer cannot act on.
 */
export type ScopeConsentState =
  | 'revokable'
  | 'revoked'
  | 'withheld'
  | 'not-granted'
  | 'fixed'
  | 'unknown';

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
 * 🔴 THE STATE TESTS ARE ORDERED `revoked` → `unknown` → `fixed` → (`revokable` | `not-granted`),
 * AND NO ADJACENT PAIR MAY BE SWAPPED.
 *
 *   - `revoked` BEFORE `revokable`: `revokedScopes` and `revokableScopes` OVERLAP by
 *     construction — `revokableScopes` is computed from `displayedScopes` with no reference to
 *     what has been withdrawn, so a scope the viewer just revoked is still in it. That is correct
 *     for the server (re-consent then re-revoke must both be possible) and wrong for a row, which
 *     has one state. Testing `revokable` first would render a live "Remove" button on a permission
 *     already gone and never show the revoked marker at all.
 *   - `unknown` AFTER `revoked`: a suppression we were told about is a fact we can still state
 *     even on a payload missing the other fields, and hiding a known withdrawal is the one
 *     regression this surface must never have.
 *   - 🔴 `fixed` BEFORE `withheld`: `revoked_at` does NOT withhold a `CONSENT_EXEMPT_SCOPES`
 *     member. `partitionByConsent` signs an exempt scope on the exempt test ALONE, before it ever
 *     consults the grant, so such a scope is still LIVE on a withheld row and its own server-side
 *     gates are still what govern it. Calling it "on hold" would tell the viewer a permission is
 *     suspended while the app is using it — false in the dangerous direction.
 *   - 🔴 `revoked` BEFORE `withheld`: on a MIGRATED database a viewer's own whole-grant revoke
 *     writes BOTH `revoked_at` and `revoked_scopes` (`revokeScopes`' `fullyRevoked` branch), so the
 *     two co-occur. "You withdrew this" is the more specific fact and the only one that records the
 *     viewer's own action; `withheld` names no actor because the column cannot carry one.
 *   - 🔴 `withheld` BEFORE the granted-set split: a withheld grant reports `grantedScopes: []`, so
 *     without this every gated row on it would fall through to `not-granted` — which is what
 *     printed "Not granted yet" over 21 real production rows.
 *   - 🔴 `fixed` BEFORE `not-granted`, AND THIS IS THE ONE THAT PRESERVES THE EXEMPT COPY. A
 *     `CONSENT_EXEMPT_SCOPES` member is NEVER in the granted set — `partitionByConsent` signs it
 *     on the exempt test alone, before it looks at the grant, so no grant is ever recorded for one
 *     — so testing `not-granted` first would relabel every one of them and throw away their specific
 *     `FIXED_SCOPE_NOTES` sentences, which are the only place a viewer learns what governs those
 *     permissions instead of their consent. Membership of `revokableScopes` is therefore decided
 *     first, and the granted set only splits what survives it.
 */
export function buildScopeConsentRows({
  scopes,
  revokedScopes,
  revokableScopes,
  grantedScopes,
  grantWithheldAt,
}: {
  scopes: string[];
  revokedScopes: string[];
  /**
   * 🔴 `undefined` AND `[]` MEAN DIFFERENT THINGS AND THE TYPE SAYS SO. `undefined` = the server
   * did not send the field (a pre-phase-2 payload); `[]` = it did, and nothing here is
   * withdrawable. The first yields `unknown` (no affordance, no claim), the second `fixed` (an
   * honest note). Coalescing them at the caller is the defect this signature exists to prevent.
   */
  revokableScopes: string[] | undefined;
  /**
   * The viewer's LIVE granted set for this app — `ScopeGrantSurface.grantedScopes`, i.e.
   * `granted_scopes ∖ revoked_scopes`, already empty for a whole-grant revoke.
   *
   * 🔴 IT IS DATA, NOT A SECOND COPY OF A DECISION, which is what makes reading it here safe
   * while re-deriving the exempt set here would not be. The exempt set is POLICY that lives in
   * `scope-grant.service.ts`; this is per-viewer state the server already sends verbatim on the
   * same row. `blocks.revokeScopes` refuses a scope outside it, so a control offered on a scope
   * missing from it is a button the server will reject.
   *
   * ⚠️ `undefined` MEANS THE SAME THING IT MEANS FOR `revokableScopes` — the server did not tell
   * us — and yields `unknown`, not "granted nothing". The two are absent together (a pre-phase-2
   * pod during a rollout's mixed-version window sends neither), so treating a missing granted set
   * as empty would turn every row of such a payload into a `not-granted` claim about the viewer's
   * own consent that we have no basis for.
   */
  grantedScopes: string[] | undefined;
  /**
   * `ScopeGrantSurface.grantWithheldAt` — when the viewer's WHOLE grant was put on hold
   * (`revoked_at`), or `null`/`undefined` if it was not.
   *
   * 🔴 NOT THE SAME COLUMN AS `scopesRevokedAt`, and it is the only thing that separates "you
   * granted this and it is on hold" from "you never granted this": both report
   * `grantedScopes: []`. Read that field's docblock on the server type before changing this — in
   * particular that it names no ACTOR and no CAUSE, because `revoked_at` has two writers.
   *
   * ⚠️ `undefined` IS TREATED AS `null`, NOT AS `unknown`, AND THAT IS DELIBERATE — unlike the two
   * fields above. A pre-4990 payload carries `revokableScopes`/`grantedScopes` but not this one,
   * and for such a payload the right answer is the one the page already gave: no withheld claim.
   * Coalescing to `unknown` instead would blank every row of a merely-slightly-older server, which
   * is a regression for a rollout window rather than a protection.
   */
  grantWithheldAt?: Date | string | null;
}): ScopeConsentRow[] {
  const revoked = new Set(revokedScopes);
  const revokable = revokableScopes === undefined ? undefined : new Set(revokableScopes);
  const granted = grantedScopes === undefined ? undefined : new Set(grantedScopes);
  // 🔴 A PRESENCE TEST, NOT A DATE PARSE. An unparseable value still means "on hold" — the hold is
  // the fact, the date is decoration — so the row state must not depend on the timestamp being
  // readable. `ScopeGrantWithheldLine` owns the parse and renders nothing on a bad value, which is
  // the same split `ScopeRevokedAtLine` already makes.
  const withheld = grantWithheldAt != null;
  const state = (scope: string): ScopeConsentState =>
    revoked.has(scope)
      ? 'revoked'
      : // The `unknown` test sits AFTER `revoked`, deliberately: a suppression we were told about
      // is a fact we can still state even on a payload missing the other fields, and hiding a
      // known withdrawal would be the one regression this surface must never have.
      revokable === undefined || granted === undefined
      ? 'unknown'
      : // 🔴 `revokableScopes` MEMBERSHIP IS TESTED BEFORE THE GRANTED SET — see the ordering
      // rules above. Every consent-EXEMPT scope falls out here, keeping its own note, and only
      // what survives is split by whether the viewer actually agreed to it.
      !revokable.has(scope)
      ? 'fixed'
      : // 🔴 THE WHOLE-GRANT HOLD, TESTED AFTER `fixed` AND BEFORE THE GRANTED-SET SPLIT — see the
      // ordering rules above; every neighbour of this line is load-bearing in a measured way.
      withheld
      ? 'withheld'
      : granted.has(scope)
      ? 'revokable'
      : 'not-granted';

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
  /**
   * 🔴 READ AND WRITE GET DIFFERENT SENTENCES, AND SHARING ONE WAS A FALSE SAFETY CLAIM.
   * Both used to read *"gated server-side on every request instead — a minimum account-trust
   * check, content moderation, and rate limits."* That is true of the WRITE path and false of the
   * READ path: in `src/server/routers/apps-shared.router.ts` the min-trust gate
   * (`assertSharedWriteTrust`) sits inside `if (!READ_OPS.has(op))`, every rate limiter is on
   * append/vote/withdraw/report, and `assertSharedTextSafe` is on the append. That router's own
   * comment says every read op *"skips that block entirely and has no second belt"*, and
   * `src/server/middleware/block-scope.middleware.ts` permits `apps:storage:shared:read` for an
   * ANON subject because the shared list and counts are public within the app.
   *
   * ⚠️ THE SOURCE COMMENT CONTRADICTS ITSELF AND THE FIRST VERSION COPIED THE WRONG HALF. The
   * `CONSENT_EXEMPT_SCOPES` declaration says the controls are enforced "at every read/write
   * REGARDLESS of the token scope" and then, two paragraphs down, that `shared:read` is "reading
   * PUBLIC community data (anon-safe — the router allows anon reads by design)". The second is the
   * one the code implements. Naming a protection that governs a different operation is the worst
   * direction for this note: the row a viewer is told they cannot withdraw is the one carrying the
   * strongest reassurance.
   */
  'apps:storage:shared:read':
    "Can't be withdrawn, and there is nothing of yours to withhold — it reads the app's SHARED " +
    'data, which is public within the app rather than personal to you.',
  'apps:storage:shared:write':
    "Can't be withdrawn. What you contribute to an app's shared data is gated server-side on " +
    'every write instead — a minimum account-trust check, content moderation, and rate limits.',
  'models:read:self':
    "Can't be withdrawn. It reads only the model on the page the app is mounted on, which is " +
    'the page you opened — the subject is fixed by where the app runs, not by a permission.',
  'collections:read:self':
    "Can't be withdrawn. Every read is checked server-side against the collection's own " +
    'visibility and ownership, so it can reach nothing you could not already see.',
  'collections:write:self':
    "Can't be withdrawn. The action is bound server-side to your own account as the subject, " +
    'so it can only bookmark on your behalf and cannot reach anyone else.',
  /**
   * 🔴 WORDING DERIVED FROM UPSTREAM'S OWN DESCRIPTION OF THE SCOPE, NOT INVENTED HERE. The
   * digital-goods rail is not this branch's feature, so the claim this note makes is taken from the
   * three places that already describe it: `server/services/blocks/scope-descriptions.constants.ts`
   * ("See which of this app's items you already own"), `shared/constants/block-action-detail.ts`
   * ("Read what you own from this app"), and the exemption's own stated basis in
   * `server/services/blocks/scope-grant.service.ts` — *"the app's OWN sales ledger, filtered to this
   * viewer … scoped to `claims.appBlockId` in the query, so it can only ever return what the calling
   * app itself sold; there is no third-party data to consent to."*
   *
   * That is the same shape of justification as `collections:read:self` above (a server-side check on
   * the subject, not a permission the viewer holds open), so it gets the same register: name the gate
   * that replaces consent, and do not imply an uninstall ends it.
   */
  'goods:read:self':
    "Can't be withdrawn. It reads only what this app itself has sold you — the query is bound " +
    'server-side to this app, so it cannot see anything you own from anywhere else.',
  'apps:store:items:write':
    "Can't be withdrawn. Only items you authored in this app can be listed, and each one is " +
    'checked server-side and reviewed by a moderator before it appears in the App Store.',
};

/**
 * The note for a `fixed` row — a specific sentence where we have one, an honest generic
 * otherwise.
 *
 * 🔴 THREE BRANCHES, BECAUSE `fixed` COVERS TWO POPULATIONS AND ONE GENERIC SENTENCE WAS FALSE
 * FOR ONE OF THEM. See `ScopeConsentState`: a row is `fixed` when it is neither revoked nor in
 * the server's `revokableScopes`, which happens for a CONSENT-EXEMPT scope (the dominant case)
 * and for an UNKNOWN one. The exempt sentence — "granted by platform policy … bounded by
 * server-side checks on every request" — is true of the first and FALSE OF THE SECOND in both
 * halves: a scope retired from the registry is granted by nothing and enforced by nothing.
 * `listMyScopeGrants` records that population as real and names it (`block:settings:read`/`write`,
 * `media:read:owned` — retired, yet still in some apps' `manifest.scopes` and `approved_scopes`,
 * so still rendered), and its own comment says such a scope is *"not mintable, grants nothing"*.
 * Telling a viewer the app holds a platform-granted privilege over their account, when it holds
 * nothing at all, is the wrong direction for a consent surface to be wrong in.
 *
 * 🔴 `isKnownBlockScope` IS THE DISCRIMINATOR AND IT COMES FROM THE SHARED REGISTRY, not from a
 * local copy. `~/shared/constants/block-scope.constants` is client-safe — that is already why
 * `BlockScopeList` imports `isSensitiveBlockScope` from it — and it is the same FUNCTION the
 * server's `revokableScopes` computation filters on.
 *
 * ⚠️ "THE CLIENT CANNOT DISAGREE WITH THE SERVER ABOUT WHICH ARM A ROW IS IN" WAS CLAIMED HERE AND
 * IS TOO STRONG. Same function, but the client runs the BUNDLE's copy of the registry and the server
 * runs the POD's — and this whole `unknown` state exists because those two can be different versions
 * during a rollout. So the honest claim is narrower: there is no separately-maintained client list to
 * drift, which removes the drift that would be permanent and silent. A version skew remains possible
 * and is transient.
 *
 * The skew that would matter is a scope NEWER than the bundle: it lands in the same `!isKnownBlockScope`
 * arm as a retired one, where the sentence says "no longer in use … the app cannot exercise it" —
 * understating what the app holds. The round-2 correctness lane looked for a reachable case and did
 * not find one (a pre-phase-2 server sends no `revokableScopes` at all, so those rows are `unknown`
 * rather than `fixed`; the harmful path needs a new-registry pod AND a stale bundle AND a brand-new
 * consent-exempt scope already live in an approved manifest). Recorded as a hazard, not a defect.
 */
/**
 * The sentence a `not-granted` row carries.
 *
 * 🔴 EXPORTED, LIKE EVERY OTHER VIEWER-FACING SENTENCE IN THIS ARC, AND FOR THE REASON THE RULES
 * GIVE: when the artifact under test IS prose, a guard on WORDS is walkable by REWORDING. Its first
 * draft was an inline literal in `ScopeConsentAction` asserted with `toMatch(/not granted/i)` — a
 * guard on two words, which any reword walks straight through. `FIXED_SCOPE_NOTES`,
 * `CONSENT_REVOKE_UNAVAILABLE_MESSAGE`, `UNGRANTABLE_CONSENT_TOAST` and
 * `scopeGrantEmptyScopeLabel` are all named for the same reason; this followed its inline
 * neighbour instead. Reported by the reuse lane.
 *
 * ⚠️ IT SAYS "not yet", DELIBERATELY. The state is not permanent — the app can ask at the point of
 * use and the consent modal grants it, at which point the same row becomes `revokable`. A flat "you
 * have not granted this" reads as a refusal.
 *
 * 🔴 THE SECOND CLAUSE IS A CLAIM ABOUT ANOTHER MODULE, so it is cross-referenced rather than left
 * to be re-derived: "the app will ask" is `partitionByConsent` returning this scope in `missing`
 * (`src/server/services/blocks/scope-grant.service.ts`), which the mint publishes as
 * `missingScopes` and `src/components/AppBlocks/BlockConsentModal.tsx` renders as the consent
 * prompt. If that path ever stops asking, this sentence becomes false and nothing here would know.
 */
export const SCOPE_NOT_GRANTED_NOTE = 'Not granted yet — the app will ask if it needs this.';

/**
 * The sentence a `withheld` row carries.
 *
 * 🔴 EVERY CLAUSE IS CONSTRAINED, AND THE OPERATOR'S SUGGESTED WORDING FAILED ONE OF ITS OWN
 * CONSTRAINTS. The brief proposed *"Withheld pending your confirmation — this permission's
 * description changed, so we're asking again"*, with the constraint that the copy be true of all 21
 * production rows. The second clause is not: measured on the primary 2026-09-28, **8 of the 21**
 * rows hold MORE THAN ONE granted scope (up to 3), and the oneoff's `UPDATE` withholds the WHOLE
 * grant — `revoked_at` collapses `liveGrantedScopes` to `[]` — while only `ai:write:budgeted`'s
 * description changed. On those 8 rows a `posts:write:self` row would be told its own description
 * changed, which is false. So the per-scope CAUSE is dropped and the sentence states the EFFECT,
 * which is true of every scope on every one of the 21.
 *
 * 🔴 IT NAMES NO ACTOR EITHER, for the reason `grantWithheldAt`'s server-side docblock gives:
 * `revoked_at` has two writers (the viewer's own last-permission revoke, and the hand-applied
 * oneoff) and the column cannot tell them apart. "You withdrew this" belongs to the `revoked`
 * state, which is tested first precisely so the viewer's own action keeps its own marker.
 *
 * ⚠️ AND IT DOES NOT CLAIM THE VIEWER PREVIOUSLY GRANTED **THIS** SCOPE, which is a limit worth
 * knowing rather than a slip. On a withheld row the surface reports `grantedScopes: []`, so a
 * declared-but-never-granted scope is indistinguishable from a granted-then-withheld one — the
 * stored `granted_scopes` column would separate them and `ScopeGrantSurface` deliberately does not
 * expose it (its own docblock argues the post-subtraction view is the only one that agrees with
 * enforcement). "not in use until you confirm this app's permissions again" is true of both: a
 * never-granted scope is not in use either, and confirming the app's permissions is what would
 * bring it into use. The distinction is carried at CARD level by `ScopeGrantWithheldLine`, not
 * per-row.
 *
 * Do not add "again" to the first clause: a row is not necessarily on hold for a second time.
 */
export const SCOPE_WITHHELD_NOTE =
  "On hold — not in use until you confirm this app's permissions again.";

export function fixedScopeNote(scope: string): string {
  /**
   * 🔴 `hasOwnProperty`, NEVER A BARE `FIXED_SCOPE_NOTES[scope]` TRUTHINESS TEST — and this repo has
   * already paid for the difference. A plain index read resolves INHERITED `Object.prototype`
   * members, so `scope === 'toString'` or `'constructor'` returns a FUNCTION, which is truthy and
   * would then be returned as a React child. `block-scope.constants.ts` carries the same rule for
   * the same reason, in its own words: use `hasOwnProperty`, never `in`, because "for those keys that
   * read yields a FUNCTION".
   *
   * ⚠️ NOT REACHABLE TODAY, AND GUARDED ANYWAY. `effectiveBlockScopes` is deliberately not
   * registry-filtered, so the only thing in front of this is submission-time validation — the scope
   * pattern requires a colon and `block-manifest-validator.service.ts` requires `isKnownBlockScope` —
   * and neither `toString` nor `constructor` contains a colon. The guard is one call, the failure
   * mode is a crash on a consent surface, and the hazard class is documented in this repo as having
   * shipped once already. Reported by the round-2 correctness lane.
   */
  const specific = Object.prototype.hasOwnProperty.call(FIXED_SCOPE_NOTES, scope)
    ? FIXED_SCOPE_NOTES[scope]
    : undefined;
  if (specific) return specific;
  if (!isKnownBlockScope(scope)) {
    return (
      'This permission is no longer in use. It cannot be withdrawn because there is nothing to ' +
      'withdraw — the app cannot exercise it, and no token carries it.'
    );
  }
  // A KNOWN scope the server did not list as revokable, with no entry above. Reachable when the
  // exempt set GROWS without this map being updated — the drift direction that degrades to
  // "correct control, less specific prose", which is the claim the module docblock now makes only
  // about this branch.
  return (
    "Can't be withdrawn here. This permission is granted by platform policy rather than by " +
    'your consent, and is bounded by server-side checks on every request instead.'
  );
}
