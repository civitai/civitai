import type { dbRead as DbRead } from '~/server/db/client';
import type { getStoreListingCandidates as GetStoreListingCandidates } from '~/server/services/blocks/app-listing.service';
import type { getMyHiddenApps as GetMyHiddenApps } from '~/server/services/blocks/my-apps-hidden.service';
import {
  buildMyApps,
  MY_APPS_RECENT_USE_DAYS,
  type MyAppsHome,
  type MyAppsSignals,
} from '~/server/services/blocks/my-apps.logic';
import type { HiddenApps } from '~/shared/utils/my-apps-hidden';
import type { ListingAudienceFloor } from '~/shared/utils/app-listing-visibility';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * The reads behind `appListings.listMyApps` — the viewer's "My apps" home. Every rule
 * (membership, revocation, dedupe, visibility, order) is in the pure `buildMyApps`; this
 * file only fetches, and every fetch is keyed on the caller's `userId` and bounded.
 *
 * Index use, per read:
 *   • `app_user_scope_grants`  — unique `(user_id, app_block_id)`, leading `user_id`;
 *   • `block_good_entitlement` — unique `(user_id, app_block_id, good_id)`, leading `user_id`;
 *   • `block_scope_invocations` — `bsi_user_invoked_idx (user_id, invoked_at DESC, id DESC)`,
 *     read as a range on the recent window with a row cap;
 *   • `"OauthConsent"`         — unique `(userId, clientId)`, leading `userId`;
 *   • the viewer's "Remove from My apps" hides (`getMyHiddenApps`, cached user settings),
 *     read concurrently with the four above because `buildMyApps` applies them before the cap.
 * Then ONE listing lookup by the resulting App Block / client ids (see
 * `getStoreListingCandidates`).
 *
 * The invocation read is deliberately NOT filtered for private-run rows: it is keyed on the
 * viewer's own `userId`, the same reasoning `scope-activity-predicate.ts` records for the
 * viewer's Activity feed, and a private run only reaches a delisted or suspended app, which
 * the store visibility gate drops anyway.
 */

/** Per-source row caps. A viewer past any of these sees their most recent apps first. */
export const MY_APPS_GRANT_TAKE = 200;
export const MY_APPS_ENTITLEMENT_TAKE = 500;
export const MY_APPS_INVOCATION_TAKE = 1000;
export const MY_APPS_CONSENT_TAKE = 200;

type MyAppsDb = Pick<
  typeof DbRead,
  'appUserScopeGrant' | 'blockGoodEntitlement' | 'blockScopeInvocation' | 'oauthConsent'
>;

export type MyAppsDeps = {
  db: MyAppsDb;
  loadCandidates: typeof GetStoreListingCandidates;
  loadHidden: typeof GetMyHiddenApps;
  now: () => Date;
};

/** What `appListings.listMyApps` returns: the home's rows, plus the hides for the client merge. */
export type MyAppsHomePayload = MyAppsHome & { hidden: HiddenApps };

export type ListMyAppsArgs = {
  userId: number;
  scope: StoreVisibilityScope;
  floor: ListingAudienceFloor;
  redCapable: boolean;
  viewerBrowsingLevel?: number | null;
  canOpenPage: boolean;
};

/**
 * The real client and loaders, imported lazily so a caller that injects them (the unit test)
 * never loads the database client or the listing / settings services' module graphs.
 */
async function resolveDeps(deps: Partial<MyAppsDeps> = {}): Promise<MyAppsDeps> {
  return {
    db: deps.db ?? (await import('~/server/db/client')).dbRead,
    loadCandidates:
      deps.loadCandidates ??
      (await import('~/server/services/blocks/app-listing.service')).getStoreListingCandidates,
    loadHidden:
      deps.loadHidden ??
      (await import('~/server/services/blocks/my-apps-hidden.service')).getMyHiddenApps,
    now: deps.now ?? (() => new Date()),
  };
}

export async function listMyApps(
  args: ListMyAppsArgs,
  deps?: Partial<MyAppsDeps>
): Promise<MyAppsHomePayload> {
  const resolved = await resolveDeps(deps);
  const { db } = resolved;
  const { userId } = args;
  const recentSince = new Date(
    resolved.now().getTime() - MY_APPS_RECENT_USE_DAYS * 24 * 60 * 60 * 1000
  );

  const [grants, entitlements, invocations, consents, hidden] = await Promise.all([
    db.appUserScopeGrant.findMany({
      where: { userId },
      select: { appBlockId: true, grantedAt: true, revokedAt: true },
      orderBy: { grantedAt: 'desc' },
      take: MY_APPS_GRANT_TAKE,
    }),
    db.blockGoodEntitlement.findMany({
      where: { userId, revokedAt: null },
      select: { appBlockId: true, grantedAt: true, revokedAt: true },
      orderBy: { grantedAt: 'desc' },
      take: MY_APPS_ENTITLEMENT_TAKE,
    }),
    db.blockScopeInvocation.findMany({
      where: { userId, invokedAt: { gte: recentSince }, appBlockId: { not: null } },
      select: { appBlockId: true, invokedAt: true },
      orderBy: [{ invokedAt: 'desc' }, { id: 'desc' }],
      take: MY_APPS_INVOCATION_TAKE,
    }),
    db.oauthConsent.findMany({
      where: { userId },
      select: { clientId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MY_APPS_CONSENT_TAKE,
    }),
    resolved.loadHidden(userId),
  ]);

  const signals: MyAppsSignals = { grants, entitlements, invocations, consents };

  const appBlockIds = new Set<string>();
  for (const g of grants) appBlockIds.add(g.appBlockId);
  for (const e of entitlements) appBlockIds.add(e.appBlockId);
  for (const i of invocations) if (i.appBlockId) appBlockIds.add(i.appBlockId);
  const connectClientIds = new Set(consents.map((c) => c.clientId));
  if (appBlockIds.size === 0 && connectClientIds.size === 0) {
    return { apps: [], removedCount: 0, removedSlugsByListingId: {}, hidden };
  }

  const candidates = await resolved.loadCandidates(
    { appBlockIds: [...appBlockIds], connectClientIds: [...connectClientIds] },
    { redCapable: args.redCapable, viewerBrowsingLevel: args.viewerBrowsingLevel }
  );

  const home = buildMyApps(signals, candidates, {
    scope: args.scope,
    floor: args.floor,
    redCapable: args.redCapable,
    canOpenPage: args.canOpenPage,
    recentSince,
    hidden,
  });
  return { ...home, hidden };
}
