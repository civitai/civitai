/**
 * W5 v0 — reflection surface for /apps/activity.
 *
 * Provides the two read-only views the v0 ships:
 *   - `listMyScopeGrants`: aggregates per-app, "what JWT scopes does this
 *     app claim + where do I have it" (model installs + subscription
 *     scopes). Derived entirely from existing tables — no grant schema
 *     yet (that's W5 v1).
 *   - `listMyAppActivity`: paginated chronological feed of
 *     `block_buzz_attribution` rows where the current user is the spender.
 *
 * No mutations here — explicitly out of scope. v0 is reflection, not
 * consent.
 */

import { appDisplayName } from '~/shared/utils/app-display-name';
import { Prisma } from '@prisma/client';
import {
  GLOBAL_SCOPE_ACTIVITY_OR,
  PRIVATE_RUN_INVOCATION_SOURCE,
  type BlockScopeInvocationInputSource,
  type BlockScopeInvocationSource,
} from '~/server/services/blocks/scope-activity-predicate';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  isBlockActionDetail,
  type BlockActionDetail,
} from '~/shared/constants/block-action-detail';
import { effectiveBlockScopes } from '~/shared/constants/block-effective-scopes';
// The registry predicate, used to keep a RETIRED scope out of the revokable list — see the
// `revokableScopes` computation for why an unknown string there broke revoke for the whole app.
import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';
import type { ScopeGrantOrigin } from '~/shared/constants/app-surface-provenance';
// STATIC, unlike the `isMissingColumnError` import inside the catch below — these two are a
// constant and a pure predicate, and this surface MUST agree with the module that decides
// what the mint does. A hand-typed `'ai:write:budgeted'` here (what this file had until the
// revoke landed) and a hand-rolled exempt list are the two ways a permissions page comes to
// disagree with enforcement: one offers a budget editor for an app that cannot spend, the
// other offers a revoke button that records a preference nothing reads. The module's own
// import graph is a subset of this one's, so this costs nothing at load time.
import {
  CONSENT_SPEND_SCOPE,
  consentGatedScopes,
  isMissingColumnError,
  liveGrantedScopes,
  logMissingBudgetColumn,
  logMissingRevokedScopesColumn,
  usableConsentBudget,
} from '~/server/services/blocks/scope-grant.service';

/**
 * The SYNTHETIC (non-FK-resolving) `appBlockId` claim namespaces a PRE-APPROVAL
 * dev-tunnel mint stamps on a `dev:live` token. A REAL AppBlock.id is ALWAYS
 * `apb_<26 ULID>`, so none of these can ever collide with one — gating the
 * synthetic-retry on this prefix set means a deleted REAL app (`apb_…`) whose
 * FK-fails is NEVER relabelled `synthetic_app_id = <real id>`; it keeps the
 * historical "log, no row" behaviour. Values verified against the mints:
 *   - `ephemeral-<slug>`   block-tokens dev-tunnel scoped mint (Phase 2 — this PR)
 *                          → `resolveDevPageBlockForAuthor` (status 'ephemeral')
 *   - `page_local_<slug>`  dev-token.ts no-row local-manifest path (`signAppBlockId`)
 *   - `pubreq_<ULID>`      dev-token.ts pending path (`signAppBlockId: pending.id`,
 *                          AppBlockPublishRequest.id = `pubreq_<ULID>`)
 * (NB: the conceptual *appId* names are `local-`/`pending-`; the *appBlockId*
 * claim these paths actually carry — the value recordScopeInvocation sees — is
 * `page_local_`/`pubreq_`.)
 */
const SYNTHETIC_APP_BLOCK_ID_PREFIXES = ['ephemeral-', 'page_local_', 'pubreq_'] as const;

function isSyntheticAppBlockId(appBlockId: string): boolean {
  return SYNTHETIC_APP_BLOCK_ID_PREFIXES.some((prefix) => appBlockId.startsWith(prefix));
}

export type ScopeGrantSurface = {
  appBlockId: string;
  slug: string;
  name: string;
  iconUrl?: string;
  /**
   * The app's EFFECTIVE scope set — `manifest.scopes ∩ AppBlock.approved_scopes`, computed by
   * the shared `effectiveBlockScopes` helper, in manifest order and de-duplicated.
   *
   * NEITHER column alone: the manifest is the dev's declaration and can be replaced without
   * re-approval, the approval is a snapshot that can name a scope a newer manifest has
   * dropped. NOT `granted_scopes` either (the consent-gated subset, narrower because it omits
   * every `CONSENT_EXEMPT_SCOPES` entry a token still carries).
   *
   * 🔴 NOT "what the mint will issue a token for" — that claim was here and it was false in
   * two ways; see the assignment site in `listMyScopeGrants`. These are the scopes the app may
   * be granted and exercised with.
   *
   * 🔴 ALWAYS `[]` WHEN `origin === 'activity'`, and that is not the intersection coming out
   * empty — it is a refusal to compute one. Such a row records that an app acted on the viewer
   * with no install and no consent, so there is no granted set, and publishing the app-side
   * ceiling on a page about what the viewer agreed to would reintroduce the over-report #4790
   * removed. The empty array is read by `scopeGrantEmptyScopeLabel`, which supplies the only
   * honest content that row has.
   */
  scopes: string[];
  /**
   * The per-UTC-day Buzz ceiling the VIEWER set for this app at consent time, or
   * `null` when they set none (in which case only the platform's own per-user daily
   * cap applies). Read from `app_user_scope_grants.buzz_budget_per_day` — the same
   * row + the same NULL semantics the SPEND path enforces against, so the
   * permissions surface cannot show a limit the enforcement does not honour.
   *
   * A REVOKED grant reports `null`, matching `getConsentBuzzBudget`: a revoked
   * grant carries no spend scope, so there is no spend for a budget to bound.
   * ⚠️ THAT BRANCH IS REACHABLE AS OF THE PER-SCOPE REVOKE, AND THIS LINE USED TO SAY
   * OTHERWISE. It described the branch as *"an INVARIANT guard over a state nothing in
   * this codebase can produce — no code path ever writes a non-null `revoked_at`"*, which
   * was true when written. `revokeScopes` (`scope-grant.service.ts`) now writes one
   * whenever a viewer's revoke empties their granted set, and the same path also nulls
   * this column outright when `ai:write:budgeted` is the scope being revoked. Do not
   * re-label either branch as an invariant guard, and do not count a test of it as
   * anything other than live coverage.
   */
  buzzBudgetPerDay: number | null;
  /**
   * True when the viewer's LIVE (non-revoked) grant row for this app actually carries
   * `ai:write:budgeted` — the one scope in the vocabulary that can spend their Buzz.
   *
   * 🔴 THIS IS NOT DERIVABLE FROM `scopes` ABOVE, and that is why it exists. `scopes` is an
   * APP-SIDE set (`manifest.scopes ∩ approved_scopes` — what the app may be granted); this is
   * the USER'S GRANT (what they actually agreed to). The budget editor on /apps/activity keys
   * off this one: a budget only bounds something when the spend scope is granted, and
   * `grantScopes` IGNORES a budget sent for an app that does not hold it — so offering the
   * control off an app-side set would render a field whose value the server silently drops.
   */
  spendScopeGranted: boolean;
  /**
   * The scopes the VIEWER currently grants this app — `granted_scopes ∖ revoked_scopes`,
   * empty for a revoked grant or no grant row at all. Sorted.
   *
   * 🔴 THIS SETTLES A DECISION THE DRAWER'S OWN DOCBLOCK RECORDED AS DELIBERATELY OPEN
   * (`AppPermissionsActivityDrawer.tsx`), AND IT DOES NOT REPLACE `scopes` ABOVE. The two
   * answer different questions and the page needs both:
   *   - `scopes`       = the APP-SIDE set, `manifest.scopes ∩ approved_scopes` — what this
   *                      app may be granted and exercised with. It is the ROW LIST.
   *   - `grantedScopes` = the USER-SIDE set — what this viewer has actually agreed to.
   *
   * Everything the existing docblock on `scopes` argues about why the EFFECTIVE set is
   * displayed rather than `granted_scopes` still stands and is preserved there: the
   * effective set is the only one correct in both divergence directions, and
   * `granted_scopes` alone UNDER-reports because it omits every `CONSENT_EXEMPT_SCOPES`
   * entry a token really carries. This field is additive for the one thing the effective
   * set cannot express — per-row consent STATE — which is precisely what a revoke control
   * has to key off. A control offered on the app-side set alone would render a "remove"
   * button for a permission the viewer never granted.
   *
   * 🔴 IT IS NOT A SUBSET OF `scopes`, AND A UI MUST NOT ASSUME IT IS. `manifest` can be
   * replaced by a publisher push without re-approval, so a scope the viewer really granted
   * last month can sit outside today's intersection. Render the intersection as rows and
   * treat a granted-but-not-displayed scope as still granted — `blocks.revokeScopes`
   * deliberately applies no manifest ceiling for the same reason.
   *
   * 🔴 AND IT IS NOT DERIVABLE FROM `spendScopeGranted`'S ABSENCE, NOR THE REVERSE — BUT THE TWO
   * ARE ONE FACT. `spendScopeGranted` is exactly `grantedScopes.includes(CONSENT_SPEND_SCOPE)`:
   * both are written from one `liveGranted` value inside one loop iteration, so they cannot
   * disagree, and the older field's docblock justifying itself as "NOT derivable" means not
   * derivable from `scopes` (the app-side set) — which is still true, and was the only set that
   * existed when it was written. Now that the client reads `grantedScopes` too, the boolean is a
   * redundant wire field rather than a second derivation; a deletion candidate on a later pass, not
   * a drift risk. Reported by the reuse lane.
   *
   * 🔴 IT IS NOW LOAD-BEARING FOR THE CONTROL, NOT ONLY FOR DISPLAY. `blocks.revokeScopes` refuses
   * a scope outside the viewer's live granted set, so `buildScopeConsentRows` intersects this with
   * `revokableScopes` to decide which rows get a Remove button — see that field's docblock for why
   * the intersection is NOT performed here. A client that stops reading this field goes back to
   * offering a control the server rejects.
   */
  grantedScopes: string[];
  /**
   * The viewer's per-scope SUPPRESSION list for this app (`revoked_scopes`), sorted.
   *
   * Disjoint from `grantedScopes` by construction. A scope can appear here while ALSO
   * appearing in the raw `granted_scopes` column — an install after a revoke unions it
   * back — which is exactly why the suppression list exists and why `getGrantedScopes`
   * subtracts it. What reaches this field is the post-subtraction view, so the two arrays
   * here never overlap.
   *
   * `[]` on a database that has not had migration
   * `20260927120000_app_user_scope_grant_revoked_scopes` applied — the only state such a
   * database can be in, not a degraded guess.
   */
  revokedScopes: string[];
  /**
   * When the MOST RECENT revoke happened for this (user, app), or `null` if none has.
   *
   * ⚠️ NOT A PER-SCOPE TIMESTAMP, AND A UI MUST NOT RENDER IT AS ONE. `revoked_scopes` is
   * a TEXT[] with nowhere to put per-entry times, and per-scope times would need a child
   * table — deliberately not built. Two revokes a week apart leave ONE value here, the
   * later. So it is honest as an app-level "permissions last changed <when>" and it is a
   * LIE printed next to an individual scope row. If phase 3 needs true per-scope times,
   * that is a schema change, not a display change.
   */
  scopesRevokedAt: Date | null;
  /**
   * When the viewer's WHOLE grant for this app was put on hold (`revoked_at`), or `null`.
   *
   * 🔴 A DIFFERENT COLUMN FROM `scopesRevokedAt`, AND THE DISTINCTION IS THE WHOLE POINT OF THE
   * FIELD. `scopesRevokedAt` is `revoked_scopes_at` — the per-app "you last withdrew something"
   * stamp, written only by `revokeScopes`. THIS is `revoked_at`, the WHOLE-GRANT flag that
   * `liveGrantedScopes` collapses the granted set to `[]` on. They are written by different
   * things, they can be non-null independently, and only this one explains why a viewer who
   * granted permissions sees an empty `grantedScopes`.
   *
   * 🔴 IT IS DERIVABLE ON THE CURRENT PRODUCTION SCHEMA, WHICH IS WHY THIS FIELD EXISTS RATHER
   * THAN A RICHER ONE. Measured on the primary 2026-09-28: the `civitai` database's
   * `app_user_scope_grants` columns are exactly `id, user_id, app_block_id, version,
   * granted_scopes, granted_at, revoked_at, buzz_budget_per_day` — `revoked_scopes` and
   * `revoked_scopes_at` do NOT exist, and **21 of 41** rows (51%, 10 users, 11 apps, all stamped
   * 2026-09-17) carry `revoked_at IS NOT NULL` with `granted_scopes` non-empty. `revoked_at` is
   * selected by BOTH the wide read and the stage-1 P2022 retry below, so this field survives the
   * pre-migration degrade. A field keyed on the new columns would have been `null` for exactly
   * the population it was added for.
   *
   * 🔴 WHAT IT IS FOR: without it the client cannot tell "you never granted this" from "you
   * granted this and it is on hold", because both report `grantedScopes: []`. That made the
   * permissions page print "Not granted yet" over 21 real rows. See `ScopeConsentState`'s
   * `withheld` arm in `src/components/Apps/scopeConsentRows.ts`.
   *
   * ⚠️ IT NAMES NO ACTOR AND NO CAUSE, because the column cannot carry either. `revoked_at` is
   * written by `revokeScopes`' `fullyRevoked` branch (the viewer withdrew their last permission)
   * AND by hand — `scripts/oneoffs/2026-09-16-reconsent-ai-write-budgeted.sql` sets it for every
   * grant holding `ai:write:budgeted`, to force a fresh consent after that scope's description
   * widened. One flag, two writers, and a UI must not assert which. The viewer's own withdrawals
   * are distinguishable by `revokedScopes` instead, which is why the client tests `revoked` first.
   */
  grantWithheldAt: Date | null;
  /**
   * The subset of `scopes` that is CONSENT-GATED at all — a necessary condition for offering a
   * revoke control, and since 4990 no longer a sufficient one.
   *
   * 🔴 A CONTROL NEEDS THIS **AND** `grantedScopes`. ⚠️ THIS LINE USED TO READ *"The subset of
   * `scopes` a revoke control may be offered on"*, full stop, and that was the defect: this field
   * is computed from the APP-SIDE set with no reference to what the viewer agreed to, so a
   * declared-but-never-granted scope rendered a live Remove button whose click wrote a durable
   * suppression for a permission never given. `blocks.revokeScopes` now refuses a scope outside the
   * viewer's live granted set, and `buildScopeConsentRows`
   * (`src/components/Apps/scopeConsentRows.ts`) intersects the two, rendering the difference in its
   * own `not-granted` state. 🔴 THE INTERSECTION IS DELIBERATELY NOT DONE HERE: collapsing the two
   * sets server-side makes a never-granted scope indistinguishable from a consent-EXEMPT one on the
   * client, which then prints the exempt note — "granted by platform policy … bounded by
   * server-side checks on every request" — about something nothing granted and nothing enforces.
   *
   * 🔴 THE SEVEN `CONSENT_EXEMPT_SCOPES` MEMBERS ARE UN-REVOKABLE AND A CONTROL ON THEM
   * WOULD BE A LIE. `partitionByConsent` signs an exempt scope on the exempt test ALONE,
   * before it consults the grant, so a suppression entry for one would be stored and
   * enforce nothing — the button would report success and the app would keep the
   * permission. `blocks.revokeScopes` refuses them with a specific error; this field is
   * how the UI avoids offering the button in the first place, so the refusal is a backstop
   * rather than the normal experience.
   *
   * Computed server-side on purpose: the exempt set lives in `scope-grant.service.ts` and
   * is the same list the MINT consults. A client-side copy would drift from the thing that
   * actually decides, silently, in the direction that offers a control that does nothing.
   */
  revokableScopes: string[];
  /**
   * WHY this row exists — `'install'` | `'consent'` | `'activity'`, in precedence order.
   *
   * 🔴 THIS IS A SERVER-SIDE DISCRIMINATOR BECAUSE THE CLIENT CANNOT DERIVE IT, AND THE
   * CLIENT WAS GETTING IT WRONG THE MOMENT THE `'activity'` CLASS EXISTED.
   * `buildScopeGrantSurfaceLine`'s predecessor read the provenance off `surfaces`: a row with
   * `subscriptionScopes.length === 0 && modelInstallCount === 0` was labelled "Granted at
   * consent · no install or subscription". An ACTIVITY-ONLY row is `0 / 0` too — that is what
   * makes it activity-only — so the counts are not a discriminator between the two classes and
   * the page would have asserted a consent that never happened. See
   * `src/shared/constants/app-surface-provenance.ts`.
   *
   * It also selects the EMPTY-SCOPE LABEL, which is the other copy site the counts cannot
   * reach: an activity-only row carries `scopes: []` by construction, and the default label
   * ("this app doesn't request any permissions") is false for an app that made scope-gated
   * API calls against this account.
   */
  origin: ScopeGrantOrigin;
  surfaces: {
    modelInstallCount: number;
    subscriptionScopes: string[];
  };
};

/**
 * Every AppBlock that has ACTED on this viewer, all-time — the third source behind a
 * permissions row.
 *
 * 🔴 ONE DATABASE AGGREGATE, NOT A PAGED ROW SWEEP — AND THE PAGING IT REPLACES BOUNDED
 * NOTHING. An earlier revision walked this table in 2,000-row pages to a 20-page ceiling, i.e.
 * fetched up to 40,000 ROWS to compute a set of a few dozen APP IDS. Measured on production
 * 2026-09-12: the heaviest block-token account holds 1,919 such rows across 13 apps, a ~148:1
 * rows-to-answer ratio. 🔴 And `take` could not limit the work it looked like it was limiting:
 * the planner reaches these rows through `bsi_app_block_invoked_idx`, whose bitmap for
 * `app_block_id IS NOT NULL` is 2,773 rows — scanned on the FIRST page for every viewer,
 * including one with zero App Block activity. Paging multiplied round-trips over an unchanged
 * scan.
 *
 * ⚠️ THAT INDEX IS NOT PARTIAL, AND AN EARLIER REVISION OF THIS COMMENT SAID IT WAS. The repo's
 * own migration is authoritative —
 * `packages/civitai-db-schema/prisma/migrations/20260530170000_w5_pin_version_and_scope_audit/migration.sql`
 * creates it as a plain btree `("app_block_id", "invoked_at" DESC)` with NO `WHERE`, and
 * `schema.full.prisma` agrees (Prisma cannot express a partial index at all). The only partial
 * index on this table is `bsi_synthetic_app_invoked_idx … WHERE "synthetic_app_id" IS NOT NULL`.
 * The plan and the timings below are unaffected — Postgres serves `app_block_id IS NOT NULL` from
 * a plain btree by scanning the non-null portion, which is what produces the "2,773 rows removed
 * by filter" line. What the wrong word changed was the WRITE-AMPLIFICATION premise: the index has
 * an entry for EVERY row of `block_scope_invocations`, not only the 2,773 App Block ones — one
 * single viewer below holds 393k `external-oauth` rows, all of them indexed here — so any
 * reasoning about its maintenance cost from the 2,773 figure is wrong by orders of magnitude.
 * (The live table's exact row count was NOT re-measured here; the 393k is a lower bound read off
 * the plan below.) If a hand-applied partial variant exists in production, the repo does not
 * declare it and that would be unverified drift — this comment asserts only what the migrations say.
 *
 * A GROUP BY is also strictly more correct, not merely cheaper: it cannot under-report, so the
 * page ceiling's truncation log — which existed because a silently truncated sweep re-creates
 * the very invisibility this function removes — has no subject left. Precedent for the shape:
 * `dbRead.blockScopeInvocation.groupBy` in
 * `src/server/services/blocks/app-analytics.service.ts`.
 *
 * MEASURED ON PRODUCTION 2026-09-12 against the nvme0 REPLICA, `EXPLAIN (ANALYZE, BUFFERS)`,
 * and COLD vs WARM are stated separately because they differ by ~7×:
 *
 *   · viewer `8753561` (1,919 rows / 13 apps — the heaviest block-token account):
 *     `Group → Sort → Bitmap Heap Scan → BitmapAnd(bsi_app_block_invoked_idx,
 *     bsi_user_invoked_idx)`, 667 heap blocks, quicksort 49 kB.
 *     COLD (first execution in the session, 57 buffer reads): **11.16 ms**.
 *     WARM (×3, all buffer hits): **1.55 / 1.44 / 1.46 ms**.
 *   · viewer `11107642` (393k rows, ALL `external-oauth`, zero App Blocks):
 *     `HashAggregate → Bitmap Heap Scan`, `Recheck Cond: app_block_id IS NOT NULL`,
 *     **953 heap blocks, 2,773 rows removed by filter**, WARM **1.68 / 0.93 ms**. A viewer with
 *     no App Block activity still pays for the whole non-null bitmap.
 *   · CONTROL, same session and same warmth — the single PAGE query this replaces
 *     (`ORDER BY invoked_at DESC, id DESC LIMIT 2000` over the same predicate): WARM
 *     **1.73 / 1.72 ms**, quicksort **183 kB**, plus a `Limit → Sort` the aggregate does not have.
 *     ⚠️ SO THE CLAIM IS "NOT SLOWER, AND DEMONSTRABLY DOING LESS WORK" — NOT "FASTER", WHICH AN
 *     EARLIER REVISION CLAIMED AND THIS INSTRUMENT CANNOT SUPPORT. Aggregate warm mean 1.483 ms
 *     (n=3) vs control 1.725 ms (n=2) is a 0.24 ms gap from ONE session on a shared replica, while
 *     the same aggregate on the other viewer spans 1.68 / 0.93 ms — a 0.75 ms intra-query spread,
 *     ~3× the effect. The work reduction is the durable half: 49 kB of quicksort against 183 kB,
 *     and no Limit+Sort at all. Add the extra round-trips the paged version needed and the
 *     conclusion stands without the timing.
 *
 * 🔴 SO THE COST SCALES WITH THE PLATFORM-WIDE NON-NULL `app_block_id` POPULATION, NOT WITH THE
 * VIEWER'S OWN VOLUME — which is the quantity App Blocks GA grows. No index is added here (at
 * ~1.5 ms warm on a once-per-tab-load query it would be write amplification for nothing), and
 * an earlier revision of this comment claimed the query "matches `bsi_user_invoked_idx` … so
 * this adds no new index need", which was false about the plan even where it was right about
 * the conclusion: that index is one ARM of a BitmapAnd on the heavy account and is not used at
 * all on the 393k-row one. If the block-token population grows by orders of magnitude the
 * remedy is a partial index —
 * `(user_id, invoked_at DESC, id DESC) WHERE app_block_id IS NOT NULL AND synthetic_app_id IS
 * NULL` — applied as raw SQL BY HAND per environment, never by `prisma migrate` (see the repo's
 * Database rule).
 *
 * ALL-TIME: there is no `invoked_at > now() - Nd` predicate, which supersedes clawgate #532's
 * own bounded-lookback acceptance criterion (the operator chose unbounded; flagged on the
 * card). A lookback bound would make an app that last acted on you outside the window silently
 * invisible again — the precise defect this change exists to remove.
 *
 * ⚠️ NO `source` FILTER, DELIBERATELY, AND IT IS NOT AN OVERSIGHT. An `external-oauth`
 * invocation has `app_block_id IS NULL` by construction (there is no App Block — the acting app
 * is captured in `oauth_client_id`), so `appBlockId: { not: null }` already excludes that whole
 * population. Filtering on `source` instead would break the pre-migration safety the rest of
 * this file maintains, for no additional exclusion. Same reasoning as
 * `GLOBAL_SCOPE_ACTIVITY_OR`'s docblock.
 *
 * 🔴 `block_buzz_attribution` IS NOT A SOURCE HERE, AND AN EARLIER REVISION MADE IT ONE ON A
 * JUSTIFICATION THAT NAMED THE WRONG TABLE. That justification read: "an un-consented BUZZ
 * SPEND is strictly more serious to be invisible than an un-consented read." True — and about a
 * different table. `block_buzz_attribution` is a PURCHASE / revenue-share ledger:
 * `recordAttribution` (`src/server/services/blocks/buzz-attribution.service.ts`) is reached
 * only from `src/pages/api/webhooks/stripe.ts` and `src/server/paddle/paddle.service.ts` after a
 * completed Buzz purchase, splitting the gross via `computeRateCardSplit`. A row there means
 * THE VIEWER BOUGHT BUZZ inside the app with their own card — so minting a row whose copy
 * describes an app that used their account without an install would be actively wrong about a
 * purchase they made themselves. An app SPENDING the viewer's Buzz needs `ai:write:budgeted`,
 * which is consent-GATED rather than exempt, and is recorded in `block_scope_invocations` as a
 * `workflow:submit:*` row — i.e. by the one leg below. The table also holds 0 rows in
 * production (re-measured 2026-09-12), so its leg was fixture-only as well as misjustified.
 */
async function listAppBlocksThatActedOnUser(userId: number): Promise<Set<string>> {
  const grouped = await dbRead.blockScopeInvocation.groupBy({
    by: ['appBlockId'],
    // 🔴 `satisfies`, NOT `as unknown as …`. The bridge cast this replaces was introduced by the
    // same change that introduced this query, and it ERASED THE KEY-NAME CHECK: measured, a
    // `syntheticAppid` typo behind the cast produced **0 type errors**, while the same typo under
    // `satisfies` produces `TS2561: Object literal may only specify known properties, but
    // 'syntheticAppid' does not exist in type 'BlockScopeInvocationWhereInput'. Did you mean to
    // write 'syntheticAppId'?`. The sibling leaf `scope-activity-predicate.ts` carries a docblock
    // recording that exactly this check was lost once here (an `appBlokId` typo typechecked
    // clean) and was deliberately restored; do not re-open it one file away from that note.
    where: {
      userId,
      // A row with no resolvable App Block cannot mint a named card, and this also excludes the
      // external-OAuth population (see the docblock above).
      appBlockId: { not: null },
      // ⚠️ AN INVARIANT GUARD — IT EXCLUDES ZERO ROWS, AND IT IS NOT THE DEVELOPER PROTECTION
      // AN EARLIER REVISION OF THIS COMMENT CLAIMED IT WAS. A pre-approval App-Dev-Tunnel call
      // writes `synthetic_app_id`, and such a row ALSO has `app_block_id IS NULL`, so the clause
      // above already excludes every one: re-measured on production 2026-09-12, all **59**
      // synthetic rows carry a null `app_block_id`, so this predicate removes **0** rows from
      // the result. Kept because it stays correct if the retry path ever learns to set both
      // columns, and because it makes the intent checkable — not because it is load-bearing.
      //
      // 🔴 AND IT CANNOT PROTECT THE DEVELOPER CASE IT WAS WRITTEN FOR. The dev-tunnel SCOPED
      // mint (`src/pages/api/v1/block-tokens/index.ts`, the `resolveOwnedNonApprovedPageBlock`
      // path) signs the app's REAL ids, so a developer driving their own APPROVED app writes
      // ordinary rows this clause is blind to. What actually keeps the card off a developer's
      // own permissions tab is the OWNER SKIP in `listMyScopeGrants` below — measured, 2 of the
      // 13 invisible pairs are the app's own author.
      syntheticAppId: null,
    } satisfies Prisma.BlockScopeInvocationWhereInput,
  });

  const found = new Set<string>();
  for (const row of grouped) {
    // The `where` above excludes nulls, so this is a SEAM guard against a future widening of
    // that predicate: without it a `null` reaches `appBlock.findMany({ id: { in: [...] } })` and
    // a Map key. `groupBy` types `appBlockId` as `string | null` because the COLUMN is nullable,
    // so the guard is also what makes this loop compile without a cast.
    if (row.appBlockId != null) found.add(row.appBlockId);
  }
  return found;
}

/**
 * Aggregates one row per AppBlock the user has installed on a model, subscribed to, granted
 * scopes to at a consent prompt, OR that has ACTED on their account with none of the above.
 * Same app counted across multiple installs + subscriptions collapses to a single row with
 * denormalised counts.
 *
 * 🔴 THREE SOURCES, IN STRICT PRECEDENCE: subscription (`'install'`) > consent grant
 * (`'consent'`, WHETHER OR NOT IT IS STILL LIVE — see the grant leg's condition) > activity alone
 * (`'activity'`). Each later leg guards on
 * `!byAppBlock.has(...)`, so an app that satisfies several keeps the RICHEST row — the one
 * carrying its real install counts, subscription scopes and budget. `origin` reports which.
 *
 * `enabled=false` model installs are excluded — a user-facing surface
 * for "what an app can do today" shouldn't surface installs the user
 * has explicitly toggled off. Subscriptions are included regardless of
 * the enabled flag because the row IS the user's claim of intent (the
 * toggle on `/apps/activity` already lets them turn it off).
 *
 * 🔴 THE GRANT LEG IS NOT A NICETY — WITHOUT IT THE BUDGET EDITOR IS UNREACHABLE FOR
 * ESSENTIALLY EVERYONE, AND THAT SHIPPED. This aggregated installs ONLY, while the
 * per-app daily Buzz budget lives on `app_user_scope_grants`. A full-page app
 * (`/apps/run/<slug>`) is consented to, never installed, so it produced NO row here —
 * and `ScopeGrantsPanel`, whose only read is this function, renders `AppBudgetControl`
 * exclusively from these rows. Measured in production 2026-09-11: the whole platform
 * held **4** `block_user_subscriptions` rows against **29** `app_user_scope_grants`,
 * and the account that had just spent 28 Buzz through a consented app saw
 * "No apps installed or subscribed yet." So the user could consent, generate and
 * spend, and had no surface on which to bound it — the exact "a budget nobody can set
 * is inert" failure the consent-budget work was meant to avoid.
 *
 * A grant-only app is therefore a first-class row with `modelInstallCount: 0` and no
 * subscription scopes. It is NOT synthesised from the manifest: it exists only when the
 * viewer has a grant row, which is their own recorded consent.
 *
 * ⚠️ "a LIVE (non-revoked) grant row" IS RETRACTED — 4990 removed the `!g.revokedAt` skip, because
 * on a grant-only app that leg is the only one that can carry the card, so a viewer who withdrew
 * their last permission lost the app from the page entirely. A fully-revoked grant now gets a row
 * too. The condition's own comment carries the measurement.
 */
export async function listMyScopeGrants(userId: number): Promise<ScopeGrantSurface[]> {
  // Post kill_per_model_installs: every install — blanket OR per-model-
  // pinned — is a `block_user_subscriptions` row. The "model install
  // count" surface now means "how many pinned subscriptions does the user
  // have for this app". Sum target_model_ids cardinality across all
  // pinned subs per app to get the count of distinct models pinned.
  const subs = (await dbRead.blockUserSubscription.findMany({
    where: { userId },
    select: {
      scope: true,
      slotId: true,
      targetModelIds: true,
      appBlockId: true,
      appBlock: {
        select: {
          id: true,
          blockId: true,
          manifest: true,
          approvedScopes: true,
        },
      },
    },
  })) as Array<{
    scope: string;
    slotId: string | null;
    targetModelIds: number[];
    appBlockId: string;
    appBlock: {
      id: string;
      blockId: string;
      manifest: unknown;
      approvedScopes: string[];
    } | null;
  }>;

  type AppBlockRow = {
    id: string;
    blockId: string;
    manifest: unknown;
    approvedScopes: string[];
  };
  type Aggregate = {
    appBlock: AppBlockRow;
    modelInstallCount: number;
    subscriptionScopes: Set<string>;
    origin: ScopeGrantOrigin;
  };
  const byAppBlock = new Map<string, Aggregate>();

  for (const row of subs) {
    if (!row.appBlock) continue;
    const isPinned =
      row.slotId !== null && Array.isArray(row.targetModelIds) && row.targetModelIds.length > 0;
    const existing = byAppBlock.get(row.appBlockId);
    if (existing) {
      if (isPinned) existing.modelInstallCount += row.targetModelIds.length;
      else existing.subscriptionScopes.add(row.scope);
    } else {
      byAppBlock.set(row.appBlockId, {
        appBlock: row.appBlock,
        modelInstallCount: isPinned ? row.targetModelIds.length : 0,
        subscriptionScopes: isPinned ? new Set() : new Set([row.scope]),
        // 🔴 THE SUBSCRIPTION LEG RUNS FIRST AND CLAIMS `'install'`, WHICH IS HOW PRECEDENCE IS
        // IMPLEMENTED: subscription > consent grant > activity-only. The two later legs both
        // guard on `!byAppBlock.has(...)`, so neither can overwrite this entry or its counts.
        origin: 'install',
      });
    }
  }

  // The consent BUDGET lives on the grant row, not on the subscription rows this
  // function aggregates — ONE indexed read for the viewer's whole grant set, rather
  // than an N+1 per row.
  //
  // 🔴 THIS READ IS NO LONGER BOUNDED BY `byAppBlock` AND THAT IS THE FIX. It used to
  // filter `appBlockId: { in: Array.from(byAppBlock.keys()) }` and to run at all only
  // when `byAppBlock.size > 0`, so a grant for an app the viewer had NOT installed was
  // never even queried — which is every full-page app. Both bounds are gone: the query
  // is keyed on `userId` alone (covered by the `(user_id, app_block_id)` unique index,
  // so this is the same index and a cheaper predicate), and grant-only apps are folded
  // into `byAppBlock` below.
  const budgetByAppBlock = new Map<string, number | null>();
  const spendGrantedByAppBlock = new Set<string>();
  const grantedScopesByAppBlock = new Map<string, string[]>();
  const revokedScopesByAppBlock = new Map<string, string[]>();
  const revokedAtByAppBlock = new Map<string, Date | null>();
  // 🔴 `revoked_at`, NOT `revoked_scopes_at` — two different columns, see `grantWithheldAt`. This
  // one survives the stage-1 P2022 retry (both selects name it), which is what makes the withheld
  // state reachable on the current production schema.
  const withheldAtByAppBlock = new Map<string, Date | null>();
  {
    type GrantRow = {
      appBlockId: string;
      buzzBudgetPerDay: number | null;
      revokedAt: Date | null;
      grantedScopes: string[];
      revokedScopes?: string[];
      revokedScopesAt?: Date | null;
      appBlock: AppBlockRow | null;
    };
    // Needed only for the grant-only apps below — a subscription-backed app already
    // carries its AppBlock from the `subs` read. Selected here rather than fetched per-app
    // so the grant leg stays a single query.
    const appBlockSelect = {
      select: { id: true, blockId: true, manifest: true, approvedScopes: true },
    } as const;
    let grants: GrantRow[] = [];
    try {
      grants = (await dbRead.appUserScopeGrant.findMany({
        where: { userId },
        select: {
          appBlockId: true,
          buzzBudgetPerDay: true,
          revokedAt: true,
          grantedScopes: true,
          revokedScopes: true,
          revokedScopesAt: true,
          appBlock: appBlockSelect,
        },
      })) as GrantRow[];
    } catch (err) {
      // 🔴 P2022 ONLY, AND IT IS NOW A TWO-STAGE DEGRADE BECAUSE TWO DIFFERENT MIGRATIONS
      // CAN BE OUTSTANDING. See `isMissingColumnError`. Any other error still throws: a
      // permissions page that quietly renders "no limits" because the DB is unreachable
      // would be a lie about the user's own settings.
      // 🔴 STATIC IMPORTS, not a dynamic one. The `await import(...)` that used to sit here
      // was justified by keeping this module off the load graph, and that justification died
      // the moment this file began importing the same module statically for
      // `liveGrantedScopes` / `consentGatedScopes` — leaving a dynamic import that read as a
      // deliberate deferral and was not one.
      if (!isMissingColumnError(err)) throw err;
      // STAGE 1 — retry WITHOUT the revocation columns
      // (`20260927120000_app_user_scope_grant_revoked_scopes`). Revocations then read as
      // "none recorded", which is the only state a database that cannot store one can be
      // in, while the BUDGET half keeps working.
      //
      // 🔴 THE RETRY EXISTS SO THE NEWER MIGRATION CANNOT BLANK THE OLDER FEATURE. Folded
      // into one catch — the shape this was before the revocation columns landed — a
      // missing `revoked_scopes` would have emptied `grants` wholesale and silently
      // regressed every budget display and every grant-only row on a database that has
      // `buzz_budget_per_day` perfectly well.
      //
      // 🔴 NOTHING IS LOGGED YET, AND THAT ORDERING IS THE FIX FOR A MISLEADING LINE. The
      // first version called `logMissingRevokedScopesColumn` HERE, before knowing which
      // column was missing — so on a database missing only `buzz_budget_per_day` the
      // once-per-process error line named the WRONG migration, and an operator would have
      // applied a migration that was already applied. The retry's OUTCOME is what
      // discriminates: it succeeding means the revocation columns were the missing ones; it
      // raising P2022 again means the budget column is missing too.
      try {
        grants = (await dbRead.appUserScopeGrant.findMany({
          where: { userId },
          select: {
            appBlockId: true,
            buzzBudgetPerDay: true,
            revokedAt: true,
            grantedScopes: true,
            appBlock: appBlockSelect,
          },
        })) as GrantRow[];
        // The narrow select succeeded, so `revoked_scopes` really was the absent column.
        // NOW it is safe to name that migration.
        logMissingRevokedScopesColumn('listMyScopeGrants', err);
      } catch (retryErr) {
        // STAGE 2 — `buzz_budget_per_day` is missing too
        // (`20260910120000_app_user_scope_grant_buzz_budget`). This is the pre-existing
        // behaviour and its argument is unchanged: with no column there is no budget any
        // user could have set, so an empty map is the TRUE state and every app reports
        // `null` (= "platform cap only"), exactly what the spend path enforces in that
        // same database.
        if (!isMissingColumnError(retryErr)) throw retryErr;
        // 🔴 BOTH MIGRATIONS ARE NAMED HERE, AND THE REORDER HAD SILENTLY DROPPED ONE. Moving
        // the revocation log after the retry fixed the wrong-migration line (it used to fire
        // before anything knew which column was missing) and created a new silent case: a
        // database missing BOTH columns reaches this arm, so the revocation migration was never
        // named at all. An operator would have applied one and still been broken.
        logMissingRevokedScopesColumn('listMyScopeGrants', retryErr);
        logMissingBudgetColumn('listMyScopeGrants', retryErr);
        grants = [];
      }
    }
    for (const g of grants) {
      // ⚠️ `g.appBlock` IS REQUIRED ON ALL THREE WRITES, NOT JUST THE ROW CREATION BELOW. An
      // earlier revision gated only the row creation on it, so a grant whose AppBlock did not
      // resolve still seeded the budget and spend maps — keys no row could ever read, except on
      // an app that some OTHER leg had minted a row for, where they would have decided that
      // row's budget control off an unresolvable grant. Inferred unreachable for the same reason
      // the row-creation guard is (required relation, `onDelete: Cascade`, no `relationMode`, so
      // Postgres enforces the FK), and aligned anyway: one predicate, applied once, is what
      // stops the three writes disagreeing.
      if (!g.appBlock) continue;
      // 🔴 THE SHARED PROJECTION, NOT A MIRROR OF IT — and the mirror it replaces had ALREADY
      // DRIFTED. This read "Mirror getConsentBuzzBudget's guards EXACTLY" while omitting
      // `Number.isFinite`, so display and enforcement disagreed for a non-finite stored value.
      // Inert (the column is an `Int?`, so `Infinity` cannot be stored and `NaN > 0` is false so
      // NaN agrees) — but a comment asserting exactness beside an inexact copy reads as coverage.
      // `usableConsentBudget` is now the single statement, exactly as `liveGrantedScopes` is for
      // the scope rule two lines below.
      const usable = usableConsentBudget(g);
      budgetByAppBlock.set(g.appBlockId, usable);
      // 🔴 THE SHARED PROJECTION, NOT A MIRROR OF IT. This used to open
      // "MIRROR `getGrantedScopes` EXACTLY, SUBTRACTION INCLUDED" and re-implement the
      // subtraction — and a comment telling you to mirror something exactly is the reliable
      // tell that a rule has two homes. Review found a THIRD home
      // (`oauth-consent-sync.service.ts`) that had it wrong, and the mirror two lines below
      // this one (for the budget guards) had already drifted. `liveGrantedScopes` is now the
      // single statement; getting this wrong in either direction is a display that disagrees
      // with enforcement — too wide offers a budget editor for an app that cannot spend, too
      // narrow hides a permission the app really holds.
      const liveGranted = liveGrantedScopes(g);
      grantedScopesByAppBlock.set(g.appBlockId, [...liveGranted].sort());
      revokedScopesByAppBlock.set(g.appBlockId, [...(g.revokedScopes ?? [])].sort());
      revokedAtByAppBlock.set(g.appBlockId, g.revokedScopesAt ?? null);
      // 🔴 SEEDED BEFORE THE `has()` PRECEDENCE CHECK BELOW, like every other map here, so a
      // withheld grant on an app that ALSO has a subscription still reports it. That row's
      // `origin` is `'install'` and the subscription leg owns its entry, but the grant is just as
      // withheld and its rows must say so.
      withheldAtByAppBlock.set(g.appBlockId, g.revokedAt ?? null);
      if (liveGranted.includes(CONSENT_SPEND_SCOPE)) {
        spendGrantedByAppBlock.add(g.appBlockId);
      }

      // A grant for an app with no install/subscription is still a thing the viewer
      // consented to, so it gets its own row — INCLUDING after they have withdrawn all of it.
      //
      // 🔴 A FULLY-REVOKED GRANT STILL GETS A CARD, AND SKIPPING IT DELETED THE APP FROM THE
      // PERMISSIONS SURFACE. ⚠️ THIS CONDITION USED TO READ `if (!g.revokedAt && !byAppBlock.has(…))`,
      // justified as *"such a grant conveys nothing, so surfacing it would offer a budget control
      // for an app that cannot spend"*. The premise is true and the conclusion did not follow: the
      // budget control is gated on `spendScopeGranted`, which is seeded from `liveGrantedScopes` and
      // is therefore ALREADY false on such a row, and `budgetByAppBlock` gets
      // `usableConsentBudget`, which returns `null` for a non-null `revoked_at`. So nothing was
      // bought, and what it cost was the whole card: a consent-modal grant on a page mint needs no
      // install, no subscription and no `block_scope_invocation` row (those come only from the REST
      // `withBlockScope` middleware and the bridge procedures), so the grant leg is the ONLY leg
      // that can carry such an app. A viewer who pressed Remove on their one permission lost the
      // app from `/apps/activity` entirely — with it the "Removed / you withdrew this" marker, the
      // `scopesRevokedAt` line, and every remaining row's control. Measured with an isolating
      // control: `(grantedScopes:[], revokedScopes:[spend,posts], revokedAt:now)` returned 0 rows
      // while the same fixture with `revokedAt:null` returned 1. The in-session `justRevoked` latch
      // masked it until unmount, so it presented on reload.
      //
      // 🔴 `buildScopeConsentRows`' OWN PRINCIPLE, APPLIED AT CARD LEVEL: *"a permissions page that
      // forgets what you withdrew is worse than one that never had the control"* — which is why
      // that function keeps a revoked scope as a ROW after the publisher drops it from the
      // manifest. A card is the same claim one level up.
      //
      // The narrower alternative — skip only when no other leg has a card — was considered and
      // rejected: it leaves two conditions that have to agree about the same thing, and it still
      // hides the withdrawal on exactly the population this feature exists for.
      //
      // ⚠️ THE `revokedScopes` DISTINCTION THAT USED TO LIVE HERE IS NOW MOOT AND IS RECORDED SO
      // NOBODY RE-INTRODUCES IT THE OTHER WAY. `revoked_at` is the whole-grant flag and
      // `revoked_scopes` is the per-scope suppression list; when this condition gated on the
      // former, keying it on "has any revocation" instead would have made a viewer's FIRST partial
      // revoke delete the card. Neither flag gates the card any more, so both shapes keep it — but
      // do not re-add a skip on either one.
      //
      // ⚠️ `g.appBlock` IS NOT RE-CHECKED HERE — the loop's own `if (!g.appBlock) continue`
      // above owns it, for all three writes. It is an invariant guard either way, not a
      // reachable branch: `AppUserScopeGrant.appBlock` is a REQUIRED relation with
      // `onDelete: Cascade` (`packages/civitai-db-schema/prisma/schema.full.prisma`) and the
      // datasource sets no `relationMode`, so Postgres enforces the FK — deleting an AppBlock
      // deletes the grant row rather than orphaning it. The subscription leg's own
      // `if (!row.appBlock) continue` is unreachable for exactly the same reason; it is
      // precedent for the shape, NOT evidence that the state occurs. (Migrations here are
      // applied by hand per environment, so "the constraint exists in prod" is not verifiable
      // from the schema alone; the guard costs nothing and is kept for that residual.) 🔴 It is
      // deliberately NOT duplicated at this condition as well: a redundantly-guarded rule is an
      // untestable one — deleting either copy leaves the suite green because each mutant dies to
      // the other — which is the same finding that removed the activity leg's second `has()`.
      //
      // The `has` check keeps the subscription leg authoritative for apps that have
      // BOTH: that entry already carries real `modelInstallCount`/`subscriptionScopes`,
      // and overwriting it here would zero them.
      if (!byAppBlock.has(g.appBlockId)) {
        byAppBlock.set(g.appBlockId, {
          appBlock: g.appBlock,
          modelInstallCount: 0,
          subscriptionScopes: new Set(),
          origin: 'consent',
        });
      }
    }
  }

  // ── THE ACTIVITY LEG — apps that ACTED on the viewer with NEITHER an install nor a consent.
  //
  // 🔴 THIS IS THE POPULATION THE PAGE WAS SILENT ABOUT, AND THE SILENCE WAS STRUCTURAL RATHER
  // THAN AN EDGE CASE. The dominant mechanism is `CONSENT_EXEMPT_SCOPES`
  // (`scope-grant.service.ts`): `partitionByConsent` returns `missing: []` for an app whose
  // scopes are ALL exempt, so no consent modal fires and `recordScopeGrant` is never reached —
  // the app can read and write the account and own no row on either of the two legs above.
  // Measured on production 2026-09-12: 13 `(user, app)` pairs across 10 users and 6 apps were
  // invisible, every one of them invocation-only (`block_buzz_attribution` is empty), and 84 of
  // 111 such calls were `collections:read:self`. Of those 13, **2** are the app's own AUTHOR
  // driving their own app and are skipped below, leaving **11** pairs over 9 users and 4 apps.
  //
  // 🔴 THE ROW DESCRIBES A RELATIONSHIP, NOT A CONSENT FAILURE — because for the CURRENT
  // population it would be wrong if it did. All six apps are FIRST-PARTY (every one owned by uid
  // `8753561`, enumerated not sampled), 4 of the 10 viewers are plausibly-public users
  // accounting for 64 of the 111 calls, and EVERY scope involved is in `CONSENT_EXEMPT_SCOPES`,
  // which `scope-grant.service.ts` documents as needing no prompt precisely because read:self
  // covers public data — "nothing sensitive to consent to". A row asserting the viewer "never
  // consented" would therefore be alleging a failure that did not occur, with no remedy to
  // offer. ⚠️ THE PARENTHETICAL HERE USED TO JUSTIFY "no remedy" WITH *"nothing in the repo
  // writes a non-null `revoked_at`"*, AND THAT HALF IS RETRACTED — `revokeScopes` writes one.
  // The conclusion survives on the OTHER half, which is the one that was always doing the
  // work: every scope in this population is CONSENT-EXEMPT, so `blocks.revokeScopes` refuses
  // it by design and a revoke control here would record a preference nothing enforces. The
  // remedy an activity-only row can offer is still nothing; the reason is exemption, not the
  // absence of a writer. The copy lives in `scopeGrantEmptyScopeLabel` /
  // `buildScopeGrantSurfaceLine`.
  //
  // 🔴 THE `has()` GUARD IS THE PRECEDENCE RULE, NOT A MICRO-OPTIMISATION. An installed or
  // consented app that has ALSO acted is the NORMAL shape, not a corner: overwriting its entry
  // here would replace real `modelInstallCount` / `subscriptionScopes` with zeros and downgrade
  // its `origin`, i.e. tell a user who installed an app that they never did. Same pattern, and
  // same reason, as the grant leg immediately above.
  //
  // The sweep runs UNCONDITIONALLY rather than only when the two legs above came back empty: an
  // acted-on-you app is orthogonal to whether the viewer installed anything else.
  {
    const actedOn = await listAppBlocksThatActedOnUser(userId);
    const needed = Array.from(actedOn).filter((id) => !byAppBlock.has(id));
    if (needed.length > 0) {
      // One batched read for the presentation columns. These ids came out of an FK column, so
      // they resolve — except where the AppBlock has since been deleted, which `findMany`
      // simply omits, giving the same "skip an unresolvable row" outcome as the legs above.
      // 🔴 NO RESULT CAST. The `as Array<AppBlockRow & { app: … }>` that used to sit here threw
      // away Prisma's own inference over this `select` — so the owner field the skip below depends
      // on was asserted rather than checked, and a `select` that stopped requesting `app` would
      // still have type-checked. Prisma already types a `select`ed `findMany` precisely; letting it
      // do so makes `app.userId` type-covered as well as test-covered (mutant M-OWN-3 plus the
      // structural "selects the app owner…" case). MEASURED, not assumed: deleting the
      // `app: { select: … }` line below now fails `pnpm typecheck` with
      // `TS2339: Property 'app' does not exist on type '{ id; blockId; manifest; approvedScopes }'`
      // at the `app.app != null` site — which it could NOT have done while the cast was asserting
      // the field into existence.
      const apps = await dbRead.appBlock.findMany({
        where: { id: { in: needed } },
        select: {
          id: true,
          blockId: true,
          manifest: true,
          approvedScopes: true,
          // 🔴 THE OWNER'S id, SELECTED ONLY FOR THE SKIP BELOW. `AppBlock` has no `userId` of its
          // own — authorship is `AppBlock.app.userId` on the `OauthClient` row.
          app: { select: { userId: true } },
        },
      });
      for (const app of apps) {
        // 🔴 THE VIEWER'S OWN APP IS NOT "AN APP THAT ACTED ON YOU". A developer driving their own
        // block writes ordinary invocation rows against their own account, and a card telling them
        // an app used their account without an install is noise at best and alarming at worst —
        // permanently, on every App Blocks author's permissions tab.
        //
        // 🔴 THIS IS THE GUARD THAT ACTUALLY DELIVERS THAT, AND `syntheticAppId: null` DOES NOT.
        // The synthetic predicate excludes the PRE-APPROVAL dev-tunnel rows only, and measured on
        // production 2026-09-12 it excludes **0** rows from this query because every one of the 59
        // synthetic rows also has `app_block_id IS NULL`. The dev-tunnel SCOPED mint
        // (`src/pages/api/v1/block-tokens/index.ts`, `resolveOwnedNonApprovedPageBlock`) signs the
        // app's REAL ids, so an author driving their own APPROVED app produces rows indistinguishable
        // from a third party's. Measured: 2 of the 13 invisible pairs are exactly that case.
        //
        // A NULL `app` is an invariant guard, not a reachable branch: `AppBlock.app` is a REQUIRED
        // relation with `onDelete: Cascade` and the datasource sets no `relationMode`, so Postgres
        // enforces the FK. Skipping on null would HIDE a row; defaulting to "not the owner" shows
        // it, which is the safe direction for a transparency surface.
        if (app.app != null && app.app.userId === userId) continue;
        // 🔴 NO SECOND `has()` CHECK HERE, AND ITS REMOVAL WAS A MUTATION-TESTING FINDING RATHER
        // THAN A TIDY-UP. This loop carried one, "re-checked rather than assumed". With the
        // `needed` filter above it that made the precedence rule REDUNDANTLY guarded — and a
        // redundantly-guarded rule is an UNTESTABLE one: deleting either guard alone left all 37
        // tests green, because each mutant died to the other guard, so neither was ever
        // exercised. (Defeating BOTH at once failed 5 tests, which is how the redundancy was
        // found rather than assumed.) One guard, in one place, is what makes the rule pinnable —
        // measured after the removal, deleting the `needed` filter above fails exactly the three
        // precedence tests, each reporting `expected 'activity' to be 'consent'/'install'`, which
        // is the downgrade stated in the failure itself. It is sufficient
        // on its own: `needed` is computed immediately before the single `await` that produced
        // `apps`, and nothing in between writes to the map.
        byAppBlock.set(app.id, {
          appBlock: app,
          modelInstallCount: 0,
          subscriptionScopes: new Set(),
          origin: 'activity',
        });
      }
    }
  }

  const result: ScopeGrantSurface[] = [];
  for (const [appBlockId, entry] of byAppBlock.entries()) {
    // Presentation fields only. `scopes` is deliberately NOT read through this cast even
    // though the effective set now needs it — the shared helper takes the raw manifest and
    // owns that extraction, so there is exactly one place that decides what a malformed
    // `scopes` value means.
    const manifest = (entry.appBlock.manifest ?? {}) as {
      name?: unknown;
      iconUrl?: unknown;
    };
    const manifestName = appDisplayName(manifest, entry.appBlock.blockId);
    const iconUrl =
      typeof manifest.iconUrl === 'string' && manifest.iconUrl.length > 0
        ? manifest.iconUrl
        : undefined;
    // 🔴 DISPLAY `manifest.scopes ∩ approved_scopes` — NEITHER COLUMN ALONE. The shared
    // helper owns the rule, the JSON-boundary defensiveness, and the order/de-dup contract;
    // see `effectiveBlockScopes` for why the intersection is the only set that is correct in
    // both divergence directions, and for the same rule's other call sites.
    //
    // The short version, because this is the surface the divergence is most visible on: a
    // publisher push (`src/pages/api/v1/developer/block-manifests.ts`) replaces `manifest`
    // and sets `status: 'pending'` without touching `approved_scopes`, and this query has NO
    // status filter, so a pending-v2 app still renders here. A v2 that ADDS a scope leaves
    // `manifest ⊋ approved`, where showing the manifest over-reports; a v2 that DROPS one
    // leaves `manifest ⊊ approved`, where showing the approval over-reports a scope the
    // current manifest no longer even requests. Only the intersection is right in both.
    //
    // 🔴 DO NOT DESCRIBE THIS AS "WHAT THE MINT WILL ISSUE A TOKEN FOR" — an earlier revision
    // of this comment did, citing `block-registry.service.ts`, and the citation was being
    // misapplied rather than misquoted. That sentence ("The mint sources scopes from
    // `approvedScopes` … NEVER the raw manifest") is TRUE of exactly TWO of the FOUR
    // scope-sourcing sites: the OWNED-NON-APPROVED dev-tunnel mint, resolved by
    // `resolveOwnedNonApprovedPageBlock`, whose docblock it lives in — it really does
    // `clampTunnelDeclaredScopes(app.approvedScopes)` there — and, since the private-run
    // surface landed, the PHASE 3 private-run mint's `clampPrivateRunScopes(app.approvedScopes,
    // …)`. ⚠️ "The dev-tunnel author mint" does NOT identify either: the OTHER dev-tunnel author
    // mint (`resolveDevPageBlockForAuthor`) sources `clampTunnelDeclaredScopes(app.scopes)` —
    // the author's own declared manifest, not the column. ⚠️ The anchors here are IDENTIFIERS
    // rather than line numbers on purpose: this comment used to cite `:650` and `:469`, and both
    // had drifted by ~90 and ~70 lines respectively. The canonical ledger is
    // `src/shared/constants/block-effective-scopes.ts`. The PRODUCTION run-token mint that
    // the apps on this page actually use sources from the MANIFEST
    // (`requestedScopes = knownManifestScopes`) with `approved_scopes` as an all-or-nothing 403
    // veto. It also refuses unless `status === 'approved'`, and this query has no status filter,
    // so this list renders apps no production token can be minted for at all. See
    // `effectiveBlockScopes` for the full statement. The honest claim is the narrower one: these
    // are the scopes the app may be granted and exercised with.
    //
    // NOT `granted_scopes`: that is only the consent-gated subset, so it UNDER-reports by
    // omitting every `CONSENT_EXEMPT_SCOPES` entry a token really carries.
    //
    // 🔴 AN ACTIVITY-ONLY ROW IS THE ONE EXCEPTION AND IT EMITS `[]` — NO SYNTHESISED CEILING.
    // The viewer granted this app nothing, so there is no grant to report, and the app-side
    // effective set would be a CEILING presented on a page whose subject is what the viewer
    // agreed to. Measured on production 2026-09-12 over the 6 apps behind the invisible pairs:
    // four of them declare 3–6 scopes and invoked exactly one (a 3–6× over-report, the defect
    // class #4790 removed), while `w6-ui-dogfood` declares one and invoked two — so the
    // declared set is not even reliably the wider of the two. The row's honest content is the
    // relationship, carried by `origin` and rendered as prose; see
    // `scopeGrantEmptyScopeLabel` in `src/shared/constants/app-surface-provenance.ts`.
    const displayedScopes =
      entry.origin === 'activity'
        ? []
        : effectiveBlockScopes(
            entry.appBlock.manifest as { scopes?: unknown } | null,
            entry.appBlock.approvedScopes
          );

    // ── THE VIEWER-SIDE CONSENT STATE phase 3's revoke control keys off. Derived from the
    // grant maps, NOT from `displayedScopes`: see `grantedScopes` on `ScopeGrantSurface`
    // for why the app-side and user-side sets are different questions and neither is a
    // subset of the other.
    //
    // 🔴 `revokableScopes` IS INTERSECTED WITH `displayedScopes`, so an activity-only row
    // (which emits `scopes: []` by construction) offers no revoke control at all. That is
    // correct rather than incidental: such a row records that an app acted on the viewer
    // with no install and no consent, entirely through `CONSENT_EXEMPT_SCOPES` — there is
    // nothing consent-gated to withdraw, and a button there would be the same lie the
    // exempt refusal in `blocks.revokeScopes` exists to prevent.
    // `consentGatedScopes`, not a re-spelling of its filter. It is the same predicate the
    // MINT consults, so a local copy would drift from the thing that actually decides — and
    // silently, in the direction that offers a control which records a preference nothing
    // reads.
    // 🔴 FILTERED TO THE KNOWN VOCABULARY TOO, AND ITS ABSENCE WOULD HAVE BROKEN REVOKE
    // ENTIRELY FOR SOME APPS. `effectiveBlockScopes` is deliberately NOT registry-filtered (its
    // own docblock says so — the mint applies that filter), and `consentGatedScopes` only
    // subtracts the exempt set. So a scope RETIRED from the registry but still present in an
    // app's `manifest.scopes` AND `approved_scopes` — `block:settings:read`/`write`,
    // `media:read:owned` — reached this list. `blocks.revokeScopes` refuses unknown strings
    // all-or-nothing, so a withdraw-all built on this field would have failed the whole call and
    // the viewer could not revoke `posts:write:self` or `ai:write:budgeted` on that app either.
    // The individual retired scope is harmless (not mintable, grants nothing); the blast radius
    // was the other scopes it took down with it.
    const revokableScopes = consentGatedScopes(displayedScopes).filter((s) => isKnownBlockScope(s));

    result.push({
      appBlockId,
      slug: entry.appBlock.blockId,
      name: manifestName,
      iconUrl,
      scopes: displayedScopes,
      origin: entry.origin,
      buzzBudgetPerDay: budgetByAppBlock.get(appBlockId) ?? null,
      spendScopeGranted: spendGrantedByAppBlock.has(appBlockId),
      grantedScopes: grantedScopesByAppBlock.get(appBlockId) ?? [],
      revokedScopes: revokedScopesByAppBlock.get(appBlockId) ?? [],
      scopesRevokedAt: revokedAtByAppBlock.get(appBlockId) ?? null,
      grantWithheldAt: withheldAtByAppBlock.get(appBlockId) ?? null,
      revokableScopes,
      surfaces: {
        modelInstallCount: entry.modelInstallCount,
        subscriptionScopes: Array.from(entry.subscriptionScopes).sort(),
      },
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export type AppActivityItem = {
  id: string;
  createdAt: Date;
  appBlockId: string;
  appName: string;
  /**
   * The app's STORE-LISTING slug (`AppBlock.blockId`), or NULL when the row's AppBlock
   * does not resolve. See "the appSlug contract" below — it is never an `AppBlock.id`.
   */
  appSlug: string | null;
  blockInstanceId: string;
  scope: string;
  usdAmountCents: number;
  status: string;
};

/* ────────────────────────────────────────────────────────────────────────────
 * THE `appSlug` CONTRACT — shared by BOTH activity feeds below.
 *
 * 🔴 `appSlug` IS A STORE-LISTING SLUG OR IT IS NULL — IT IS NEVER AN `AppBlock` PRIMARY
 * KEY, AND THE FALLBACK THAT MADE IT ONE WAS A GUARANTEED 404.
 *
 * Both feeds used to emit `appSlug: r.appBlock?.blockId ?? r.appBlockId`. Those two
 * columns are not interchangeable: `AppBlock.blockId` is the SLUG that `AppListing.slug`
 * mirrors (`app-listing-mapper.ts` writes `slug: ab.blockId`) and that
 * `/apps/run/<slug>` resolves, while `appBlockId` is the FOREIGN KEY — the AppBlock's
 * `id`. So whenever the join did NOT resolve, the fallback handed the UI a primary key
 * dressed as a slug, and `ActivityAppName` rendered `/apps/store-preview/<pk>`: a link
 * that can only 404, offered precisely on the rows where the app is least resolvable.
 * That join genuinely does come back null — a scope-invocation row's `appBlockId` is
 * NULLABLE (a pre-approval App-Dev-Tunnel spend writes `appBlockId: null` +
 * `syntheticAppId`), and a `Restrict`-deleted AppBlock leaves the same shape.
 *
 * The fix is a NULL, not a better fallback: a row with no resolvable AppBlock has no
 * listing to link to, and the consumer's job is to render plain text. That is
 * `AppNameCrumb`'s rule ("Omitted → no store cluster … not a broken link"), applied at
 * the source rather than re-derived per call site — and it is deliberately NOT a
 * per-row client fetch, which on a paginated table would be an N+1.
 *
 * `appName` keeps its `?? r.appBlockId` tail on purpose: that is a DISPLAY string with no
 * navigational meaning, so a last-resort identifier there is worse-looking, not broken.
 * ──────────────────────────────────────────────────────────────────────────── */

export type AppActivityPage = {
  items: AppActivityItem[];
  nextCursor: string | null;
};

const APP_ACTIVITY_MAX_LIMIT = 100;

/**
 * Paginated, viewer-scoped activity feed. Walks `block_buzz_attribution`
 * filtered by `userId = ctx.user.id` (the spender, NOT the app owner).
 *
 * Cursor is the row id; orderBy attributedAt DESC, id DESC for a stable
 * tiebreak. We fetch `limit + 1` so the trailing row signals "has next"
 * without a count() round-trip; the cursor returned is the LAST visible
 * row's id (Prisma's cursor + skip:1 pattern).
 */
export async function listMyAppActivity({
  userId,
  appBlockId,
  limit,
  cursor,
}: {
  userId: number;
  appBlockId?: string;
  limit?: number;
  cursor?: string;
}): Promise<AppActivityPage> {
  const cappedLimit = Math.min(Math.max(limit ?? 25, 1), APP_ACTIVITY_MAX_LIMIT);
  type Row = {
    id: string;
    attributedAt: Date;
    appBlockId: string;
    blockInstanceId: string;
    scope: string;
    usdAmountCents: number;
    status: string;
    appBlock: { blockId: string; manifest: unknown } | null;
  };
  const rows = (await dbRead.blockBuzzAttribution.findMany({
    where: {
      userId,
      // Optional per-app drill-down (mirrors listMyScopeInvocations). Server-side
      // so the cursor paginates the SINGLE app's Buzz feed — a whole-account fetch
      // + client filter would under-report this app's spend behind other apps'
      // rows on page 1 ("No activity yet" false negative).
      ...(appBlockId ? { appBlockId } : {}),
    },
    orderBy: [{ attributedAt: 'desc' }, { id: 'desc' }],
    take: cappedLimit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      attributedAt: true,
      appBlockId: true,
      blockInstanceId: true,
      scope: true,
      usdAmountCents: true,
      status: true,
      appBlock: { select: { blockId: true, manifest: true } },
    },
  })) as Row[];

  const hasNext = rows.length > cappedLimit;
  const visible = hasNext ? rows.slice(0, cappedLimit) : rows;
  const nextCursor = hasNext ? visible[visible.length - 1]?.id ?? null : null;

  const items: AppActivityItem[] = visible.map((r) => {
    const manifest = (r.appBlock?.manifest ?? {}) as { name?: unknown };
    const appName =
      typeof manifest.name === 'string' && manifest.name.length > 0
        ? manifest.name
        : r.appBlock?.blockId ?? r.appBlockId;
    return {
      id: r.id,
      createdAt: r.attributedAt,
      appBlockId: r.appBlockId,
      appName,
      // NULL, not `?? r.appBlockId` — see "the appSlug contract" above. `appBlockId` is
      // the FK (AppBlock.id), and emitting it here produced `/apps/store-preview/<pk>`.
      appSlug: r.appBlock?.blockId ?? null,
      blockInstanceId: r.blockInstanceId,
      scope: r.scope,
      usdAmountCents: r.usdAmountCents,
      status: r.status,
    };
  });

  return { items, nextCursor };
}

/* ============================================================================
 * W5 v0.5 — per-subscription version pin + scope-invocation audit log
 *
 * After the 2026-05-30 kill_per_model_installs migration, the per-model
 * install row is just a `block_user_subscriptions` row with slot_id +
 * target_model_ids populated. `pinned_version` lives on the subscription;
 * `setSubscriptionPinnedVersion` is the write path that replaces the
 * removed `setInstallPinnedVersion`.
 *
 * The /apps/activity surface uses `BlockRegistry.listUserSubscriptions`
 * for the read side (it already returns availableVersions + pinned model
 * names + slotId / pinnedVersion on each row), so there is no separate
 * "list my model installs" call anymore.
 * ==========================================================================*/

/**
 * Persists the per-subscription version pin. Pass `version=null` to clear
 * (revert to "latest" semantics — host loads the current AppBlock
 * manifest). Pass a semver string to pin. Caller MUST validate that the
 * version exists in approved publish requests for the subscription's
 * AppBlock — service rejects unknown versions to keep the pin coherent.
 */
export async function setSubscriptionPinnedVersion(opts: {
  userId: number;
  subscriptionId: string;
  version: string | null;
}): Promise<{ ok: true }> {
  const { userId, subscriptionId, version } = opts;
  // Pinning is a write on a row the user must own — user_id is the
  // authoritative ownership column on block_user_subscriptions. Defense
  // -in-depth check at the service boundary keeps the API safe to call
  // from non-tRPC paths.
  const sub = await dbRead.blockUserSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, appBlockId: true, userId: true },
  });
  if (!sub) throw new Error('subscription not found');
  if (sub.userId !== userId) {
    throw new Error('not the subscription owner');
  }

  if (version !== null) {
    const exists = await dbRead.appBlockPublishRequest.findFirst({
      where: { appBlockId: sub.appBlockId, version, status: 'approved' },
      select: { id: true },
    });
    if (!exists) {
      throw new Error(`version "${version}" is not an approved release of this app`);
    }
  }

  await dbWrite.blockUserSubscription.update({
    where: { id: subscriptionId },
    data: { pinnedVersion: version },
  });
  return { ok: true };
}

export type ScopeInvocationItem = {
  /** String form of the BigSerial id — JSON-safe + stable cursor value. */
  id: string;
  createdAt: Date;
  appBlockId: string;
  appName: string;
  /**
   * The app's STORE-LISTING slug (`AppBlock.blockId`), or NULL when the row's AppBlock
   * does not resolve — which on THIS feed is a live case, not a theoretical one: a
   * pre-approval App-Dev-Tunnel spend writes `appBlockId: null` + `syntheticAppId`. See
   * "the appSlug contract" above `AppActivityItem`.
   */
  appSlug: string | null;
  blockInstanceId: string;
  scope: string;
  endpoint: string;
  statusCode: number;
  /**
   * W13 — structured per-action detail for a mutation row (NULL for a passive
   * read or a pre-W13 row). The view resolves its subject-ref ids → names and
   * renders a human sentence; a null detail falls back to scope · endpoint.
   */
  detail: BlockActionDetail | null;
};

export type ScopeInvocationPage = {
  items: ScopeInvocationItem[];
  nextCursor: string | null;
};

const SCOPE_INVOCATION_MAX_LIMIT = 100;

/**
 * Cursor-paginated walk of `block_scope_invocations` filtered to the
 * current viewer. Same shape as listMyAppActivity so the UI can
 * interleave the two feeds without bespoke pagination glue. Cursor is
 * the BigSerial `id` cast to string (JSON can't carry int64 losslessly).
 */
export async function listMyScopeInvocations(opts: {
  userId: number;
  appBlockId?: string;
  limit?: number;
  cursor?: string;
}): Promise<ScopeInvocationPage> {
  const cappedLimit = Math.min(Math.max(opts.limit ?? 25, 1), SCOPE_INVOCATION_MAX_LIMIT);
  // Cursor is the string form of a BigInt id. Coerce defensively; an
  // invalid cursor is treated as "start from the beginning" rather than
  // throwing — a stale localStorage value can otherwise break the feed.
  let cursorBigInt: bigint | null = null;
  if (opts.cursor) {
    try {
      cursorBigInt = BigInt(opts.cursor);
    } catch {
      cursorBigInt = null;
    }
  }

  type Row = {
    id: bigint;
    invokedAt: Date;
    appBlockId: string;
    blockInstanceId: string;
    scope: string;
    endpoint: string;
    statusCode: number;
    detail: unknown;
    appBlock: { blockId: string; manifest: unknown } | null;
  };
  const rows = (await dbRead.blockScopeInvocation.findMany({
    // This is the BLOCK-token activity feed (/apps/activity). Unified scope-usage
    // audit: EXTERNAL-OAuth invocations now share this table but carry a NULL
    // `appBlockId` (+ `source = 'external-oauth'`); exclude them here so they don't
    // leak into a block-semantic UI. But NOT every null-`appBlockId` row is
    // external-OAuth: a PRE-APPROVAL App-Dev-Tunnel spend also writes `appBlockId:
    // null` with `syntheticAppId` set (see the synthetic-retry path below) and MUST
    // stay in the dev's own audit feed. So the GLOBAL feed keeps `app-block` AND
    // synthetic rows and excludes only external-OAuth: `appBlockId IS NOT NULL OR
    // syntheticAppId IS NOT NULL`. Both are PRE-EXISTING columns, so this read is
    // safe whether or not the `source`/`oauth_client_id` migration has been applied
    // (external-OAuth rows can't even exist pre-migration — they're naturally
    // absent then, and `syntheticAppId IS NOT NULL` excludes exactly the
    // external-OAuth population post-migration). Deliberately NOT filtering on the
    // new `source`/`oauthClientId` columns keeps this pre-migration-safe. External
    // usage is captured (queryable by `oauth_client_id`) for a future dedicated
    // OAuth-app activity view. Cast: the nullable filters need the nullable-column
    // client types (CI-regenerated; may lag locally).
    where: {
      userId: opts.userId,
      ...(opts.appBlockId ? { appBlockId: opts.appBlockId } : GLOBAL_SCOPE_ACTIVITY_OR),
    } as unknown as Prisma.BlockScopeInvocationWhereInput,
    orderBy: [{ invokedAt: 'desc' }, { id: 'desc' }],
    take: cappedLimit + 1,
    ...(cursorBigInt != null ? { cursor: { id: cursorBigInt }, skip: 1 } : {}),
    select: {
      id: true,
      invokedAt: true,
      appBlockId: true,
      blockInstanceId: true,
      scope: true,
      endpoint: true,
      statusCode: true,
      detail: true,
      appBlock: { select: { blockId: true, manifest: true } },
    },
  })) as Row[];

  const hasNext = rows.length > cappedLimit;
  const visible = hasNext ? rows.slice(0, cappedLimit) : rows;
  const nextCursor =
    hasNext && visible.length > 0 ? visible[visible.length - 1]!.id.toString() : null;

  const items: ScopeInvocationItem[] = visible.map((r) => {
    const manifest = (r.appBlock?.manifest ?? {}) as { name?: unknown };
    const appName =
      typeof manifest.name === 'string' && manifest.name.length > 0
        ? manifest.name
        : r.appBlock?.blockId ?? r.appBlockId;
    return {
      id: r.id.toString(),
      createdAt: r.invokedAt,
      appBlockId: r.appBlockId,
      appName,
      // NULL, not `?? r.appBlockId` — see "the appSlug contract" above. `appBlockId` is
      // the FK (AppBlock.id), and emitting it here produced `/apps/store-preview/<pk>`.
      appSlug: r.appBlock?.blockId ?? null,
      blockInstanceId: r.blockInstanceId,
      scope: r.scope,
      endpoint: r.endpoint,
      statusCode: r.statusCode,
      // Narrow the JSON column back to the structured shape; a garbage/legacy
      // value renders via the scope · endpoint fallback (detail = null).
      detail: isBlockActionDetail(r.detail) ? r.detail : null,
    };
  });

  return { items, nextCursor };
}

/**
 * Fire-and-forget INSERT into `block_scope_invocations`. Called from
 * block-scope.middleware.ts on every successful scope-gated API call.
 * Errors are logged + swallowed — the audit pipeline must NEVER affect
 * the user-facing response, which has already shipped by the time this
 * runs (registered on `res.on('finish')`).
 */
export async function recordScopeInvocation(opts: {
  userId: number;
  /**
   * The App Block whose block-token made the call. Present for an `'app-block'`
   * invocation; OMITTED (undefined) for an `'external-oauth'` invocation, which
   * has no App Block — the acting app is captured in `oauthClientId` instead.
   */
  appBlockId?: string;
  /**
   * The block instance. Present for an `'app-block'` invocation; OMITTED for an
   * `'external-oauth'` invocation (a pure OauthClient has no block instance).
   */
  blockInstanceId?: string;
  /**
   * Unified scope-usage audit — the acting OauthClient id for an
   * `'external-oauth'` invocation (an external OAuth access token verified at
   * `enforceTokenScope`). This is the "which app" for external OAuth API usage,
   * mirroring what `appBlockId` is for a block-token row. OMITTED for a
   * block-token row.
   */
  oauthClientId?: string;
  /**
   * Which token population made the call: `'app-block'` (block-token — the
   * default when omitted, preserving every existing block-token record) or
   * `'external-oauth'` (a standard external OAuth access token). Consumers filter
   * on this. Omitting it lets the DB column DEFAULT ('app-block') apply, so the
   * existing block-token call sites write a byte-identical row.
   *
   * 🔴 THE MARKER IS NOT IN THIS TYPE, AND THAT IS THE POINT. `'private-run'` is derived
   * from the verified `privateRun` claim below, so the claim→value mapping has exactly one
   * home. An earlier revision typed this field with the column's FULL three-value union —
   * which made the marker settable here, with no claim behind it, while this very paragraph
   * asserted it was not. The column's whole value space is `BlockScopeInvocationSource`;
   * what a CALLER may pass is this narrower half.
   */
  source?: BlockScopeInvocationInputSource;
  scope: string;
  endpoint: string;
  statusCode: number;
  /**
   * 🔴 Set from the VERIFIED `privateRun` token claim — a moderator, owner or accepted
   * listing collaborator running a delisted/suspended app's deployed bundle. When true the
   * row is written with `source: PRIVATE_RUN_INVOCATION_SOURCE`, which is what every
   * OWNER-VISIBLE aggregate in `app-analytics.service.ts` excludes.
   *
   * ── WHY IT IS A BOOLEAN HERE AND A `source` VALUE IN THE ROW ─────────────────────
   * ONE RULE, ONE PLACE. Nine call sites feed this helper; if each computed the column
   * value itself, the mapping from claim to marker would exist nine times and could drift
   * at any one of them. Call sites thread the claim (the only value an RS256 signature has
   * vouched for) and this function performs the single mapping, immediately below.
   *
   * 🔴 ABSENT MUST MEAN "AN ORDINARY ROW", NOT "SUPPRESS" — it tests `=== true`, so a
   * missing or garbage value fails toward the pre-existing behaviour. The mirror hazard is
   * the expensive one: a row wrongly marked private-run VANISHES from its owner's
   * analytics, and nobody reports numbers they never saw.
   *
   * ⚠️ It is NOT a substitute for the `source` field above, and the two are disjoint by
   * construction: `source: 'external-oauth'` is passed only by the external-OAuth audit,
   * whose token can never carry a block-token claim. If both ever arrive the private-run
   * marker WINS — the safer direction, since the cost of a wrongly-marked external-OAuth
   * row is a row missing from an owner aggregate that never contained it (external-OAuth
   * rows have no `appBlockId`), while the cost of the reverse is the leak this exists to
   * close.
   */
  privateRun?: boolean;
  /**
   * App Dev Tunnel Phase 2 — set when the token is a DEV token (`claims.dev`).
   * A dev token MAY carry a SYNTHETIC, non-FK-resolving `appBlockId` (a
   * PRE-APPROVAL app has no AppBlock row: `ephemeral-<slug>` / `page_local_<slug>`
   * / `pubreq_<ULID>` — see SYNTHETIC_APP_BLOCK_ID_PREFIXES). When the direct
   * INSERT FK-fails for such a token AND the id is synthetic-prefixed we retry
   * with `appBlockId: null` + `syntheticAppId` so the durable per-spend audit row
   * PERSISTS instead of being swallowed. The APPROVED dev-token path carries a
   * REAL `apb_<ulid>` appBlockId and writes on the first attempt (no retry); a
   * REAL app deleted between mint and spend also FK-fails but is NOT synthetic —
   * it keeps the historical "log, no row" behaviour. Absent/false `dev` → the
   * historical behaviour (a real FK orphan just logs, no row).
   */
  dev?: boolean;
  /**
   * W13 — structured per-action audit detail for an impactful MUTATION (tip /
   * workflow submit / settings update / storage set|delete|increment). Stored
   * verbatim into the nullable `detail` JSON column; the view resolves its
   * subject-ref ids → display names at render time. ABSENT for a passive read
   * (whose label is derived from `scope`). Narrowed defensively — a malformed
   * value is dropped so the row still writes plain.
   */
  detail?: BlockActionDetail | null;
}): Promise<void> {
  // Narrow the detail once; a garbage value writes a plain (detail-less) row
  // rather than poisoning the INSERT. Reused on the synthetic-retry path below.
  const detailData: Prisma.InputJsonValue | undefined = isBlockActionDetail(opts.detail)
    ? (opts.detail as unknown as Prisma.InputJsonValue)
    : undefined;
  // 🔴 THE SINGLE MAPPING from the verified private-run claim to the row's marker, resolved
  // ONCE here so both the direct INSERT and the synthetic-retry path below write the same
  // value. Private-run WINS over an explicitly-passed `source` — see the `privateRun`
  // docblock for why that is the safe direction. `undefined` (the ordinary case) leaves the
  // key off the row entirely, so every existing call site stays byte-identical and `source`
  // falls to the DB DEFAULT.
  // 🔴 TYPED WITH THE UNION, NOT `string`. An earlier revision widened it to `string` just
  // to hold the third value, which silently dropped the only compile-time check on the
  // column's value space — and this module's sibling leaf records that exact lesson
  // (a looser annotation let an `appBlokId` typo typecheck at zero errors). The `data`
  // object below is bridge-cast, so this annotation is the last place a typo can be caught.
  //
  // 🔴 AND THE VERIFIED CLAIM IS THE *ONLY* ROUTE TO THE MARKER, ENFORCED AT RUNTIME AND NOT
  // ONLY BY THE TYPE. Narrowing the input type to exclude `'private-run'` makes the compiler
  // refuse an in-repo caller — proven, `TS2322` — but A TYPE DECLARATION IS NOT A CODE PATH:
  // a cast, a value crossing a `JSON.parse`, or the next widening of that type all reach the
  // runtime, and this field's type had ALREADY been widened once. A behavioural case caught
  // exactly this and was RED until the line below existed.
  //
  // The fallback is `undefined`, i.e. an ORDINARY row — the safe direction, because the cost
  // of a wrongly-MARKED row is the owner's real usage silently vanishing from their own
  // dashboard, which this module calls the more expensive failure.
  //
  // ⚠️ THE `as string` IS THE LOAD-BEARING PART, NOT NOISE. Without it TypeScript refuses the
  // comparison outright — `TS2367: … have no overlap` — because the narrowed input type
  // already excludes the marker. That error is the compiler being RIGHT about the type and
  // WRONG about the runtime: the only values that can reach here carrying the marker are
  // precisely the ones that got past the type, which is what this line exists for. Widening
  // for the comparison is how the check survives its own type guarantee.
  const passedSource: BlockScopeInvocationInputSource | undefined =
    (opts.source as string | undefined) === PRIVATE_RUN_INVOCATION_SOURCE ? undefined : opts.source;
  const sourceForRow: BlockScopeInvocationSource | undefined =
    opts.privateRun === true ? PRIVATE_RUN_INVOCATION_SOURCE : passedSource;
  try {
    // Build the row conditionally so an `'app-block'` call site writes a
    // BYTE-IDENTICAL row to the pre-unification shape (no `oauthClientId` /
    // `source` keys — `source` falls to the DB DEFAULT 'app-block'), while an
    // `'external-oauth'` call site adds only the fields it carries. Bridge-cast
    // once: the locally-generated Prisma client may pre-date the `oauth_client_id`
    // / `source` columns (the NixOS dev env can't run `prisma generate`); CI
    // regenerates from schema.full.prisma. Field names mirror the schema exactly.
    const data = {
      userId: opts.userId,
      appBlockId: opts.appBlockId,
      blockInstanceId: opts.blockInstanceId,
      ...(opts.oauthClientId !== undefined ? { oauthClientId: opts.oauthClientId } : {}),
      ...(sourceForRow !== undefined ? { source: sourceForRow } : {}),
      scope: opts.scope,
      // Endpoint string is bounded by middleware-side normalisation but
      // belt-and-braces clamp here so a runaway path can't blow the row.
      endpoint: opts.endpoint.slice(0, 512),
      statusCode: opts.statusCode,
      ...(detailData !== undefined ? { detail: detailData } : {}),
    } as unknown as Parameters<typeof dbWrite.blockScopeInvocation.create>[0]['data'];
    await dbWrite.blockScopeInvocation.create({ data });
  } catch (err) {
    // App Dev Tunnel Phase 2: a DEV token with a SYNTHETIC (non-resolving)
    // appBlockId FK-fails here. Retry with `appBlockId: null` + `syntheticAppId`
    // so the pre-approval per-spend audit row PERSISTS (the durable trail the
    // synthetic-appId attribution path can't write). Scoped to `dev === true` +
    // an FK violation so a deleted REAL app on the normal path keeps the historical
    // "log, no row" behaviour (never mislabelled synthetic).
    const isFkViolation =
      typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2003';
    // Gate the synthetic path on a SYNTHETIC-id PREFIX, not merely `dev && P2003`.
    // A dev token can carry a REAL `apb_<ulid>` appBlockId whose AppBlock row was
    // deleted between mint and spend — that FK-fails too, but it is NOT synthetic,
    // so it must keep the historical "log, no row" behaviour (never mislabelled
    // `synthetic_app_id = <real id>`). Only a genuine synthetic namespace retries.
    if (
      opts.dev &&
      isFkViolation &&
      opts.appBlockId != null &&
      isSyntheticAppBlockId(opts.appBlockId)
    ) {
      try {
        // `appBlockId: null` + `syntheticAppId` require the schema change in this
        // PR (BlockScopeInvocation.appBlockId → nullable, + synthetic_app_id).
        // The generated Prisma client is regenerated from that schema at build
        // time (postinstall → `pnpm db:generate`); this bridge cast keeps the
        // source type-clean against a client generated BEFORE the migration lands
        // (the NixOS dev env can't run `prisma generate`). Field names mirror the
        // schema exactly — see schema.full.prisma model BlockScopeInvocation.
        const retryData = {
          userId: opts.userId,
          appBlockId: null,
          syntheticAppId: opts.appBlockId,
          blockInstanceId: opts.blockInstanceId,
          // 🔴 CARRIED ONTO THE RETRY TOO, even though the pair is refused upstream. The
          // token verifier rejects `privateRun && dev` outright, and this branch is gated on
          // `dev`, so a private-run row can never reach here today. It is written anyway so
          // the marker's correctness does not DEPEND on that refusal holding: if the pair
          // ever becomes reachable, the row is still marked rather than silently landing
          // unmarked. Costs one conditional; removes a reasoning dependency between two
          // files. (The value is `undefined` on every live path, so this key is absent and
          // the retry row stays byte-identical to what it wrote before.)
          ...(sourceForRow !== undefined ? { source: sourceForRow } : {}),
          scope: opts.scope,
          endpoint: opts.endpoint.slice(0, 512),
          statusCode: opts.statusCode,
          ...(detailData !== undefined ? { detail: detailData } : {}),
        } as unknown as Parameters<typeof dbWrite.blockScopeInvocation.create>[0]['data'];
        await dbWrite.blockScopeInvocation.create({ data: retryData });
        return;
      } catch (retryErr) {
        // Fall through to the best-effort log below with the retry error.
        err = retryErr;
      }
    }
    // Don't let an audit-write failure crash the request lifecycle. Most
    // common cause: app_block_id FK orphaned because the block was
    // deleted between token issuance and this scope call.
    logToAxiom(
      {
        name: 'block-scope-invocation-log-failed',
        type: 'warn',
        appBlockId: opts.appBlockId,
        scope: opts.scope,
        endpoint: opts.endpoint,
        error: err instanceof Error ? err.message : String(err),
      },
      'civitai-prod'
    ).catch(() => {
      /* axiom unreachable — give up */
    });
  }
}
