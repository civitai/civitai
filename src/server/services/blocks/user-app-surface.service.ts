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
  surfaces: {
    modelInstallCount: number;
    subscriptionScopes: string[];
  };
};

/**
 * Aggregates one row per AppBlock the user has installed on a model,
 * subscribed to, OR granted scopes to at a consent prompt. Same app counted
 * across multiple installs + subscriptions collapses to a single row with
 * denormalised counts.
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
      // ⚠️ `g.appBlock` IS A SECOND INVARIANT GUARD, NOT A REACHABLE BRANCH — stated because
      // an earlier revision of this comment implied otherwise. `AppUserScopeGrant.appBlock`
      // is a REQUIRED relation with `onDelete: Cascade`
      // (`packages/civitai-db-schema/prisma/schema.full.prisma`), and the datasource sets no
      // `relationMode`, so Postgres enforces the FK: deleting an AppBlock deletes the grant
      // row rather than orphaning it. The subscription leg's own `if (!row.appBlock) continue`
      // is unreachable for exactly the same reason — it is precedent for the shape, NOT
      // evidence that the state occurs. (Migrations here are applied by hand per environment,
      // so "the constraint exists in prod" is not verifiable from the schema alone; the guard
      // costs nothing and is kept for that residual.)
      //
      // The `has` check keeps the subscription leg authoritative for apps that have
      // BOTH: that entry already carries real `modelInstallCount`/`subscriptionScopes`,
      // and overwriting it here would zero them.
      if (!g.revokedAt && g.appBlock && !byAppBlock.has(g.appBlockId)) {
        byAppBlock.set(g.appBlockId, {
          appBlock: g.appBlock,
          modelInstallCount: 0,
          subscriptionScopes: new Set(),
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
    const displayedScopes = effectiveBlockScopes(
      entry.appBlock.manifest as { scopes?: unknown } | null,
      entry.appBlock.approvedScopes
    );

    result.push({
      appBlockId,
      slug: entry.appBlock.blockId,
      name: manifestName,
      iconUrl,
      scopes: displayedScopes,
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
