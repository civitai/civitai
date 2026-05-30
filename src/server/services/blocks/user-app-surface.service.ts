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

/* ============================================================================
 * W5 v0.5 — per-install version pin + scope-invocation audit log
 * ==========================================================================*/

export type ModelInstallVersionInfo = {
  version: string;
  approvedAt: Date | null;
};

export type ModelInstallSurface = {
  blockInstanceId: string;
  installId: string;
  modelId: number;
  modelName: string;
  modelVersionId: number | null;
  slotId: string;
  enabled: boolean;
  pinnedVersion: string | null;
  appBlockId: string;
  appSlug: string;
  appName: string;
  /**
   * AppBlock's manifest-declared current version. Equivalent to "latest"
   * for the version dropdown. Null when the AppBlock predates the W2
   * versioning columns (hackathon-era rows).
   */
  currentVersion: string | null;
  /**
   * Distinct approved versions for this app, newest first. The UI
   * renders this as the "pin to a specific version" dropdown.
   */
  availableVersions: ModelInstallVersionInfo[];
};

/**
 * Lists every model_block_installs row the current user owns (installed
 * by them) with the data the /apps/installed Model installs tab needs:
 * model name, app metadata, pinned version, and the list of approved
 * versions to pick from.
 *
 * Approved versions are per-AppBlock, not per-install — so a separate
 * query batches them keyed on appBlockId. Returned as denormalised data
 * on each install row so the UI doesn't have to join client-side.
 */
export async function listMyModelInstalls(userId: number): Promise<ModelInstallSurface[]> {
  type InstallRow = {
    id: string;
    blockInstanceId: string;
    modelId: number;
    modelVersionId: number | null;
    slotId: string;
    enabled: boolean;
    pinnedVersion: string | null;
    appBlockId: string;
    model: { id: number; name: string } | null;
    appBlock: {
      id: string;
      blockId: string;
      manifest: unknown;
      version: string | null;
    } | null;
  };
  const installs = (await dbRead.modelBlockInstall.findMany({
    where: { installedByUserId: userId },
    orderBy: [{ installedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      blockInstanceId: true,
      modelId: true,
      modelVersionId: true,
      slotId: true,
      enabled: true,
      pinnedVersion: true,
      appBlockId: true,
      model: { select: { id: true, name: true } },
      appBlock: {
        select: { id: true, blockId: true, manifest: true, version: true },
      },
    },
  })) as InstallRow[];

  if (installs.length === 0) return [];

  // Batch-fetch distinct approved versions for the apps the user has
  // installed. groupBy gives us (appBlockId, version, max(reviewedAt)) so
  // we can sort newest-first inside each app.
  const appBlockIds = Array.from(new Set(installs.map((i) => i.appBlockId)));
  type VersionGroupRow = {
    appBlockId: string | null;
    version: string;
    _max: { reviewedAt: Date | null };
  };
  const versionRows = (await dbRead.appBlockPublishRequest.groupBy({
    by: ['appBlockId', 'version'],
    where: {
      appBlockId: { in: appBlockIds },
      status: 'approved',
    },
    _max: { reviewedAt: true },
  })) as unknown as VersionGroupRow[];

  const versionsByApp = new Map<string, ModelInstallVersionInfo[]>();
  for (const row of versionRows) {
    if (!row.appBlockId) continue;
    const list = versionsByApp.get(row.appBlockId) ?? [];
    list.push({ version: row.version, approvedAt: row._max.reviewedAt });
    versionsByApp.set(row.appBlockId, list);
  }
  for (const list of versionsByApp.values()) {
    list.sort((a, b) => {
      const at = a.approvedAt?.getTime() ?? 0;
      const bt = b.approvedAt?.getTime() ?? 0;
      return bt - at;
    });
  }

  return installs.map<ModelInstallSurface>((row) => {
    const manifest = (row.appBlock?.manifest ?? {}) as { name?: unknown };
    const appName =
      typeof manifest.name === 'string' && manifest.name.length > 0
        ? manifest.name
        : row.appBlock?.blockId ?? row.appBlockId;
    return {
      blockInstanceId: row.blockInstanceId,
      installId: row.id,
      modelId: row.modelId,
      modelName: row.model?.name ?? `Model ${row.modelId}`,
      modelVersionId: row.modelVersionId,
      slotId: row.slotId,
      enabled: row.enabled,
      pinnedVersion: row.pinnedVersion,
      appBlockId: row.appBlockId,
      appSlug: row.appBlock?.blockId ?? row.appBlockId,
      appName,
      currentVersion: row.appBlock?.version ?? null,
      availableVersions: versionsByApp.get(row.appBlockId) ?? [],
    };
  });
}

/**
 * Persists the per-install version pin. Pass `version=null` to clear
 * (revert to "latest" semantics — host loads the current AppBlock
 * manifest). Pass a semver string to pin. Caller MUST validate that the
 * version exists in approved publish requests for the install's
 * AppBlock — service rejects unknown versions to keep the pin coherent.
 */
export async function setInstallPinnedVersion(opts: {
  userId: number;
  blockInstanceId: string;
  version: string | null;
}): Promise<{ ok: true }> {
  const { userId, blockInstanceId, version } = opts;
  // Pinning is a write on a row the user must own — installedByUserId is
  // the only authoritative ownership column (the surrounding tRPC proc
  // also asserts modelId ownership, but a defense-in-depth check at the
  // service boundary keeps the API safe to call from non-tRPC paths).
  const install = await dbRead.modelBlockInstall.findUnique({
    where: { blockInstanceId },
    select: { id: true, appBlockId: true, installedByUserId: true },
  });
  if (!install) throw new Error('install not found');
  if (install.installedByUserId !== userId) {
    throw new Error('not the install owner');
  }

  if (version !== null) {
    const exists = await dbRead.appBlockPublishRequest.findFirst({
      where: { appBlockId: install.appBlockId, version, status: 'approved' },
      select: { id: true },
    });
    if (!exists) {
      throw new Error(`version "${version}" is not an approved release of this app`);
    }
  }

  await dbWrite.modelBlockInstall.update({
    where: { blockInstanceId },
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
