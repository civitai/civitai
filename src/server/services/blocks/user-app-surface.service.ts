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

import { dbRead } from '~/server/db/client';

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
  // Two parallel reads: per-app install counts (enabled rows only,
  // joined to the AppBlock that backs them) + every active subscription.
  // Both are scoped to user-owned data only; no cross-user leakage.
  const [installs, subs] = await Promise.all([
    dbRead.modelBlockInstall.findMany({
      where: { installedByUserId: userId, enabled: true },
      select: {
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
    }),
    dbRead.blockUserSubscription.findMany({
      where: { userId },
      select: {
        scope: true,
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
    }),
  ]);

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

  for (const row of installs as Array<{
    appBlockId: string;
    appBlock: AppBlockRow | null;
  }>) {
    if (!row.appBlock) continue;
    const existing = byAppBlock.get(row.appBlockId);
    if (existing) {
      existing.modelInstallCount += 1;
    } else {
      byAppBlock.set(row.appBlockId, {
        appBlock: row.appBlock,
        modelInstallCount: 1,
        subscriptionScopes: new Set(),
      });
    }
  }

  for (const row of subs as Array<{
    scope: string;
    appBlockId: string;
    appBlock: AppBlockRow | null;
  }>) {
    if (!row.appBlock) continue;
    const existing = byAppBlock.get(row.appBlockId);
    if (existing) {
      existing.subscriptionScopes.add(row.scope);
    } else {
      byAppBlock.set(row.appBlockId, {
        appBlock: row.appBlock,
        modelInstallCount: 0,
        subscriptionScopes: new Set([row.scope]),
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
  limit,
  cursor,
}: {
  userId: number;
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
    where: { userId },
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
