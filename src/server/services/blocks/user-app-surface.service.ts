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

import { Prisma } from '@prisma/client';
import { GLOBAL_SCOPE_ACTIVITY_OR } from '~/server/services/blocks/scope-activity-predicate';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  isBlockActionDetail,
  type BlockActionDetail,
} from '~/shared/constants/block-action-detail';
import { effectiveBlockScopes } from '~/shared/constants/block-effective-scopes';
import type { ScopeGrantOrigin } from '~/shared/constants/app-surface-provenance';

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
   * ⚠️ That branch is an INVARIANT guard over a state nothing in this codebase can
   * produce — no code path ever writes a non-null `revoked_at` — see
   * `getConsentBuzzBudget`.
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
 * the planner reaches these rows through the partial `bsi_app_block_invoked_idx
 * (app_block_id IS NOT NULL)`, whose whole bitmap is 2,773 rows — scanned on the FIRST page for
 * every viewer, including one with zero App Block activity. Paging multiplied round-trips over
 * an unchanged scan.
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
 *     **1.73 / 1.72 ms**, quicksort **183 kB**. So the aggregate is faster than ONE page of the
 *     paged version, before counting the extra round-trips.
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
 * 🔴 THREE SOURCES, IN STRICT PRECEDENCE: subscription (`'install'`) > live consent grant
 * (`'consent'`) > activity alone (`'activity'`). Each later leg guards on
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
 * viewer has a live (non-revoked) grant row, which is their own recorded consent.
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
  {
    type GrantRow = {
      appBlockId: string;
      buzzBudgetPerDay: number | null;
      revokedAt: Date | null;
      grantedScopes: string[];
      appBlock: AppBlockRow | null;
    };
    let grants: GrantRow[] = [];
    try {
      grants = (await dbRead.appUserScopeGrant.findMany({
        where: { userId },
        select: {
          appBlockId: true,
          buzzBudgetPerDay: true,
          revokedAt: true,
          grantedScopes: true,
          // Needed only for the grant-only apps below — a subscription-backed app
          // already carries its AppBlock from the `subs` read. Selected here rather
          // than fetched per-app so the grant leg stays a single query.
          appBlock: {
            select: {
              id: true,
              blockId: true,
              manifest: true,
              approvedScopes: true,
            },
          },
        },
      })) as GrantRow[];
    } catch (err) {
      // 🔴 P2022 ONLY — the deploy is running ahead of its migration and
      // `buzz_budget_per_day` does not exist yet. See `isMissingColumnError`. With no
      // column there is no budget any user could have set, so an empty map is the TRUE
      // state and every app reports `null` (= "platform cap only"), which is exactly
      // what the spend path enforces in that same database. Any other error still
      // throws: a permissions page that quietly renders "no limits" because the DB is
      // unreachable would be a lie about the user's own settings.
      const { isMissingColumnError, logMissingBudgetColumn } = await import(
        '~/server/services/blocks/scope-grant.service'
      );
      if (!isMissingColumnError(err)) throw err;
      logMissingBudgetColumn('listMyScopeGrants', err);
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
      // Mirror getConsentBuzzBudget's guards EXACTLY — revoked → null, and a
      // non-positive stored value → null — so this display can never disagree with
      // what the spend path enforces.
      const usable =
        !g.revokedAt && typeof g.buzzBudgetPerDay === 'number' && g.buzzBudgetPerDay > 0
          ? Math.floor(g.buzzBudgetPerDay)
          : null;
      budgetByAppBlock.set(g.appBlockId, usable);
      // Mirror `getGrantedScopes`: a revoked row grants nothing.
      if (!g.revokedAt && (g.grantedScopes ?? []).includes('ai:write:budgeted')) {
        spendGrantedByAppBlock.add(g.appBlockId);
      }

      // A live grant for an app with no install/subscription is still a thing the
      // viewer consented to and can spend through, so it gets its own row.
      //
      // 🔴 REVOKED ROWS ARE SKIPPED, matching `getGrantedScopes`/`getConsentBuzzBudget`:
      // a revoked grant conveys nothing, so surfacing it would offer a budget control
      // for an app that cannot spend. (Nothing in the repo writes a non-null
      // `revoked_at` today, so this is an invariant guard, not a reachable branch —
      // labelled as such rather than counted as coverage.)
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
      if (!g.revokedAt && !byAppBlock.has(g.appBlockId)) {
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
  // offer (nothing in the repo writes a non-null `revoked_at`). The copy lives in
  // `scopeGrantEmptyScopeLabel` / `buildScopeGrantSurfaceLine`.
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
      const apps = (await dbRead.appBlock.findMany({
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
      })) as Array<AppBlockRow & { app: { userId: number } | null }>;
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
    const manifestName = typeof manifest.name === 'string' ? manifest.name : entry.appBlock.blockId;
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
    // `approvedScopes` … NEVER the raw manifest") is TRUE of exactly ONE of the THREE
    // scope-sourcing sites: the OWNED-NON-APPROVED dev-tunnel mint, resolved by
    // `resolveOwnedNonApprovedPageBlock`, whose docblock it lives in — `block-tokens/index.ts:650`
    // really does `clampTunnelDeclaredScopes(app.approvedScopes)` there. ⚠️ "The dev-tunnel author
    // mint" does NOT identify it: the OTHER dev-tunnel author mint
    // (`resolveDevPageBlockForAuthor`, `:469`) sources `clampTunnelDeclaredScopes(app.scopes)` —
    // the author's own declared manifest, not the column. The PRODUCTION run-token mint that
    // the apps on this page actually use is the THIRD path, and it sources from the MANIFEST
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

    result.push({
      appBlockId,
      slug: entry.appBlock.blockId,
      name: manifestName,
      iconUrl,
      scopes: displayedScopes,
      origin: entry.origin,
      buzzBudgetPerDay: budgetByAppBlock.get(appBlockId) ?? null,
      spendScopeGranted: spendGrantedByAppBlock.has(appBlockId),
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
   */
  source?: 'app-block' | 'external-oauth';
  scope: string;
  endpoint: string;
  statusCode: number;
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
      ...(opts.source !== undefined ? { source: opts.source } : {}),
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
