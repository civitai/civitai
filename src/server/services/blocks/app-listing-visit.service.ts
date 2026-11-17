import type { NextApiRequest, NextApiResponse } from 'next';

import { isAutomatedUserAgent } from '~/server/utils/bot-detection/automated-agent';
import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { isRedCapableHost } from '~/server/utils/server-domain';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import {
  APP_STORE_LISTING_ID_RE,
  parseAppSurface,
  type AppSurface,
} from '~/shared/utils/app-store-telemetry';
import type { Session, SessionUser } from '~/types/session';

/**
 * OFF-SITE VISIT — the `/apps/go/<listingId>` redirect behind every store "Visit" link: resolve
 * the listing under the detail page's own visibility gate, record one `App_Visit`, 302.
 *
 * 🔴 NOT AN OPEN REDIRECT. The destination comes only from the stored row
 * (`getStoreVisibleOffsiteDestination` → its https `externalUrl`); no code path reads a URL from
 * the request — the only inputs are the listing id (generated-id pattern) and `?src=` (closed set).
 *
 * 🔴 `recorded` IS NEVER AWAITED BY THE ROUTE, and every recording error is swallowed, so the
 * redirect never waits on or fails because of ClickHouse.
 */

/**
 * The `details` of one `App_Visit` row: an id and a closed value. No referrer: every Visit link
 * is `rel="noreferrer"`, so the header is empty for store-originated visits and `surface` already
 * carries the on-site origin.
 */
export function appVisitDetails({
  listingId,
  surface,
}: {
  listingId: string;
  surface: AppSurface;
}): { listingId: string; surface: AppSurface } {
  return { listingId, surface };
}

type VisitRequestContext = {
  req: { headers: Record<string, string | string[] | undefined> };
  res: unknown;
};

/** Everything with I/O, injectable so the decision logic is unit-tested without a server. */
export type AppVisitDeps = {
  resolveScope: (user: SessionUser | undefined) => Promise<StoreVisibilityScope>;
  resolveFloor: (user: SessionUser | undefined) => Promise<ListingAudienceFloor>;
  findDestination: (
    listingId: string,
    opts: {
      redCapable: boolean;
      scope: StoreVisibilityScope;
      floor: ListingAudienceFloor;
      viewerBrowsingLevel: number;
    }
  ) => Promise<{ id: string; url: string } | null>;
  recordEvent: (
    details: ReturnType<typeof appVisitDetails>,
    ctx: VisitRequestContext,
    session: Session | null
  ) => Promise<unknown>;
};

export const defaultAppVisitDeps: AppVisitDeps = {
  resolveScope: async (user) => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    return resolveStoreVisibilityScope({ user });
  },
  resolveFloor: async (user) => {
    const { resolveViewerAudienceFloor } = await import('~/server/services/app-blocks-flag');
    return resolveViewerAudienceFloor({ user });
  },
  findDestination: async (listingId, opts) => {
    const { getStoreVisibleOffsiteDestination } = await import(
      '~/server/services/blocks/app-listing.service'
    );
    return getStoreVisibleOffsiteDestination(listingId, opts);
  },
  recordEvent: async (details, ctx, session) => {
    const { Tracker } = await import('~/server/clickhouse/client');
    const tracker = new Tracker(
      ctx.req as unknown as NextApiRequest,
      ctx.res as unknown as NextApiResponse,
      session
    );
    // Actor metadata KEPT (no `skipActorMeta`), like `App_Open`: it is what lets a rollup
    // collapse a refresh loop per user / IP.
    return tracker.action({ type: 'App_Visit', details });
  },
};

export type AppVisitRequest = {
  /** The `[listingId]` route param, as Next delivers it. */
  listingId: unknown;
  /** The request's query. Only `src` is read; anything else (a `url`, `to`, …) is ignored. */
  query: Record<string, unknown> | undefined;
  session: Session | null | undefined;
  /** `canViewNsfw` decides the browsing level, as on the detail page. */
  features?: { canViewNsfw?: boolean };
  ctx: VisitRequestContext;
};

/**
 * Decide one visit. Returns the destination to redirect to, or null for "not found" (the
 * caller 404s). Recording is started, never awaited; the returned promise `recorded` exists
 * for tests and must not be awaited by the route.
 */
export async function resolveAppListingVisit(
  request: AppVisitRequest,
  deps: AppVisitDeps = defaultAppVisitDeps
): Promise<{ destination: string; recorded: Promise<void> } | null> {
  const { listingId, query, session, features, ctx } = request;
  if (typeof listingId !== 'string' || !APP_STORE_LISTING_ID_RE.test(listingId)) return null;

  const user = session?.user ?? undefined;
  const [scope, floor] = await Promise.all([deps.resolveScope(user), deps.resolveFloor(user)]);
  if (scope === 'none') return null;

  const host = ctx.req.headers.host;
  const destination = await deps.findDestination(listingId, {
    redCapable: isRedCapableHost(typeof host === 'string' ? host : undefined),
    scope,
    floor,
    viewerBrowsingLevel: getServerBrowsingLevel({
      canViewNsfw: !!features?.canViewNsfw,
      user,
    }),
  });
  if (!destination) return null;

  const surface = parseAppSurface(query?.src);
  const recorded = recordVisit({
    listingId: destination.id,
    surface,
    session: session ?? null,
    ctx,
    deps,
  });
  return { destination: destination.url, recorded };
}

// One raw row per hit and no Postgres write: `visit_count` is derived from these rows by the
// listing metrics job under the play de-dupe (one actor per listing per UTC day).
async function recordVisit({
  listingId,
  surface,
  session,
  ctx,
  deps,
}: {
  listingId: string;
  surface: AppSurface;
  session: Session | null;
  ctx: VisitRequestContext;
  deps: AppVisitDeps;
}): Promise<void> {
  // Crawlers and link unfurlers are redirected but not recorded. A UA pattern test — attribution
  // only (spoofable), so it gates nothing else.
  if (isAutomatedUserAgent(ctx.req.headers['user-agent'])) return;
  try {
    await deps.recordEvent(appVisitDetails({ listingId, surface }), ctx, session);
  } catch {
    // A lost row is a slightly low number; a throw here would be a failed redirect.
  }
}
