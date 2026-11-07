import type { NextApiRequest, NextApiResponse } from 'next';

import { getServerBrowsingLevel } from '~/server/utils/browsing-level';
import { isRedCapableHost } from '~/server/utils/server-domain';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import {
  APP_STORE_LISTING_ID_RE,
  parseAppSurface,
  referrerHostOf,
  type AppSurface,
} from '~/shared/utils/app-store-telemetry';
import type { Session, SessionUser } from '~/types/session';

/**
 * OFF-SITE VISIT — the `/apps/go/<listingId>` redirect behind every store "Visit" link.
 *
 * An off-site listing's CTA used to be a plain `target="_blank"` anchor straight to the third
 * party, so no on-platform request followed the click and the store had no way to know an
 * off-site app was ever used (`App_Open` and `open_count` are on-site only, by design). This
 * route is the on-platform request: it resolves the listing, records one `App_Visit` row and
 * 302s to the listing's STORED external URL. It writes NOTHING to Postgres.
 *
 * 🔴 NOT AN OPEN REDIRECT, AND THE SHAPE IS WHAT GUARANTEES IT. The destination is read from
 * the database (`getStoreVisibleOffsiteDestination` → the row's `externalUrl`, https-only)
 * and nothing else: this module never reads a URL from the request. The only request inputs
 * are the listing id (validated against a generated-id pattern) and `?src=` (parsed to a
 * closed set). A `?url=` / `?to=` / `?next=` on the request is ignored because no code path
 * looks at it.
 *
 * 🔴 SAME GATE AS THE DETAIL PAGE. The listing must pass `loadStoreVisibleListingRow` under
 * this viewer's store scope, audience floor, host and browsing level — the predicate
 * `appListings.getAppDetail` applies — so the redirect cannot be used to reach (or to confirm
 * the existence of) a listing the viewer's store would 404. An on-site listing, a hidden one,
 * a missing one and one with no https destination all return null alike.
 *
 * 🔴 THE EVENT IS RAW; THE COUNT IS DERIVED. Every hit writes an `App_Visit` row WITH actor
 * metadata (userId / ip, like `App_Open`). `app_listing_metrics.visit_count` is recomputed from
 * those rows by the listing metrics job (`buildAppVisitCountSql` in
 * `appListing.metrics.sql.ts`) under the SAME rule as plays — one distinct actor per listing per
 * UTC day — so a refresh loop costs rows, not visits, and the number can always be recomputed.
 * There is deliberately no `+1` path here.
 *
 * 🔴 FIRE-AND-FORGET AFTER THE DECISION. Recording never sits in front of the redirect and
 * never fails it: the event is started without being awaited and swallows its own errors.
 */

/** The `details` of one `App_Visit` row: an id, a closed value and a bare hostname. */
export function appVisitDetails({
  listingId,
  surface,
  referer,
}: {
  listingId: string;
  surface: AppSurface;
  referer: unknown;
}): { listingId: string; surface: AppSurface; referrerHost?: string } {
  const referrerHost = referrerHostOf(referer);
  return { listingId, surface, ...(referrerHost ? { referrerHost } : {}) };
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
  try {
    await deps.recordEvent(
      appVisitDetails({ listingId, surface, referer: ctx.req.headers.referer }),
      ctx,
      session
    );
  } catch {
    // A lost row is a slightly low number; a throw here would be a failed redirect.
  }
}
