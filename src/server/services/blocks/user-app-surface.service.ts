/**
 * W5 v0 — reflection surface for /apps/installed.
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

import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

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
  scopes: string[];
  surfaces: {
    modelInstallCount: number;
    subscriptionScopes: string[];
  };
};

/**
 * Aggregates one row per AppBlock the user has either installed on a
 * model or subscribed to. Same app counted across multiple installs +
 * subscriptions collapses to a single row with denormalised counts.
 *
 * `enabled=false` model installs are excluded — a user-facing surface
 * for "what an app can do today" shouldn't surface installs the user
 * has explicitly toggled off. Subscriptions are included regardless of
 * the enabled flag because the row IS the user's claim of intent (the
 * toggle on `/apps/installed` already lets them turn it off).
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
      row.slotId !== null &&
      Array.isArray(row.targetModelIds) &&
      row.targetModelIds.length > 0;
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

  const result: ScopeGrantSurface[] = [];
  for (const [appBlockId, entry] of byAppBlock.entries()) {
    const manifest = (entry.appBlock.manifest ?? {}) as {
      name?: unknown;
      iconUrl?: unknown;
      scopes?: unknown;
    };
    const manifestName = typeof manifest.name === 'string' ? manifest.name : entry.appBlock.blockId;
    const iconUrl =
      typeof manifest.iconUrl === 'string' && manifest.iconUrl.length > 0
        ? manifest.iconUrl
        : undefined;
    // Prefer the manifest-declared scopes (the dev's stated intent). The
    // approved_scopes column is the moderator-narrowed set used at JWT
    // issuance; surfacing both would be confusing for v0. Fall back to
    // approved_scopes when manifest.scopes is missing or malformed.
    const manifestScopes = Array.isArray(manifest.scopes)
      ? (manifest.scopes.filter((s) => typeof s === 'string') as string[])
      : entry.appBlock.approvedScopes ?? [];

    result.push({
      appBlockId,
      slug: entry.appBlock.blockId,
      name: manifestName,
      iconUrl,
      scopes: manifestScopes,
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
  appSlug: string;
  blockInstanceId: string;
  scope: string;
  usdAmountCents: number;
  status: string;
};

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
      appSlug: r.appBlock?.blockId ?? r.appBlockId,
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
 * The /apps/installed surface uses `BlockRegistry.listUserSubscriptions`
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
  appSlug: string;
  blockInstanceId: string;
  scope: string;
  endpoint: string;
  statusCode: number;
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
    appBlock: { blockId: string; manifest: unknown } | null;
  };
  const rows = (await dbRead.blockScopeInvocation.findMany({
    where: {
      userId: opts.userId,
      ...(opts.appBlockId ? { appBlockId: opts.appBlockId } : {}),
    },
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
      appBlock: { select: { blockId: true, manifest: true } },
    },
  })) as Row[];

  const hasNext = rows.length > cappedLimit;
  const visible = hasNext ? rows.slice(0, cappedLimit) : rows;
  const nextCursor =
    hasNext && visible.length > 0
      ? visible[visible.length - 1]!.id.toString()
      : null;

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
      appSlug: r.appBlock?.blockId ?? r.appBlockId,
      blockInstanceId: r.blockInstanceId,
      scope: r.scope,
      endpoint: r.endpoint,
      statusCode: r.statusCode,
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
  appBlockId: string;
  blockInstanceId: string;
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
}): Promise<void> {
  try {
    await dbWrite.blockScopeInvocation.create({
      data: {
        userId: opts.userId,
        appBlockId: opts.appBlockId,
        blockInstanceId: opts.blockInstanceId,
        scope: opts.scope,
        // Endpoint string is bounded by middleware-side normalisation but
        // belt-and-braces clamp here so a runaway path can't blow the row.
        endpoint: opts.endpoint.slice(0, 512),
        statusCode: opts.statusCode,
      },
    });
  } catch (err) {
    // App Dev Tunnel Phase 2: a DEV token with a SYNTHETIC (non-resolving)
    // appBlockId FK-fails here. Retry with `appBlockId: null` + `syntheticAppId`
    // so the pre-approval per-spend audit row PERSISTS (the durable trail the
    // synthetic-appId attribution path can't write). Scoped to `dev === true` +
    // an FK violation so a deleted REAL app on the normal path keeps the historical
    // "log, no row" behaviour (never mislabelled synthetic).
    const isFkViolation =
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2003';
    // Gate the synthetic path on a SYNTHETIC-id PREFIX, not merely `dev && P2003`.
    // A dev token can carry a REAL `apb_<ulid>` appBlockId whose AppBlock row was
    // deleted between mint and spend — that FK-fails too, but it is NOT synthetic,
    // so it must keep the historical "log, no row" behaviour (never mislabelled
    // `synthetic_app_id = <real id>`). Only a genuine synthetic namespace retries.
    if (opts.dev && isFkViolation && isSyntheticAppBlockId(opts.appBlockId)) {
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
