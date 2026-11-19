import { getListingCta } from '~/components/Apps/appListingCardView';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import { storeVisibleListingRowGate } from '~/server/services/blocks/app-listing-store-gate';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type {
  AppListingVisibility,
  ListingAudienceFloor,
} from '~/shared/utils/app-listing-visibility';
import { isHiddenFromHome, type HiddenApps } from '~/shared/utils/my-apps-hidden';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

/**
 * The viewer's "My apps" home (`/apps`) — which apps they HAVE, derived from data that
 * already exists. Pure: rows in, list out, so every rule below is unit-testable without a
 * database (`__tests__/my-apps.logic.test.ts`). The reads live in `my-apps.service.ts`.
 *
 * Membership, per kind:
 *   • a full-page app (on-site listing whose manifest declares a page) — the viewer holds a
 *     LIVE (`revokedAt` null) scope grant, OR a live good entitlement, OR has a scope
 *     invocation against it inside the recent window;
 *   • an off-site app — the viewer holds an OAuth consent for the listing's connect client.
 *     A consent has no revoked state: revoking deletes the row.
 *
 * Slot-only on-site apps (no page — the model-page blocks) are out of scope: they are
 * managed under Activity, and a launcher tile for them would have nowhere to launch.
 *
 * Every listing must also pass the store's own visibility gate for THIS request
 * (`storeVisibleListingRowGate`, the predicate the detail page uses), so a delisted,
 * unpublished, moderation-removed, restricted, undeployed or off-host-mature listing never
 * appears, and neither does an on-site listing for a viewer whose scope is off-site only.
 *
 * "Remove from My apps" hides are applied HERE, before the row cap, with the shared predicate
 * (`isHiddenFromHome`) against the row's `lastUsedAt` — so a removed app never takes one of
 * the capped slots and the next app past the cutoff shows instead. See `my-apps-hidden.ts`
 * for why that is safe for an app the viewer has since reopened.
 */

/** How far back a scope invocation still counts as "uses this app". */
export const MY_APPS_RECENT_USE_DAYS = 30;

/** The most tiles the home renders. */
export const MY_APPS_MAX_ROWS = 100;

export type MyAppsSignals = {
  grants: ReadonlyArray<{ appBlockId: string; grantedAt: Date | null; revokedAt: Date | null }>;
  entitlements: ReadonlyArray<{
    appBlockId: string;
    grantedAt: Date | null;
    revokedAt: Date | null;
  }>;
  invocations: ReadonlyArray<{ appBlockId: string | null; invokedAt: Date | null }>;
  consents: ReadonlyArray<{ clientId: string; updatedAt: Date | null }>;
};

export type MyAppsListingCandidate = {
  card: Pick<
    ListingCard,
    'id' | 'slug' | 'name' | 'category' | 'kind' | 'kindData' | 'iconUrl' | 'coverUrl'
  >;
  appBlockId: string | null;
  connectClientId: string | null;
  gate: {
    row: { status: string; kind: string; contentRating: string | null; revisionOfId: null };
    visibility: AppListingVisibility | null;
    deployedAt: Date | null;
  };
};

export type MyAppKind = 'page' | 'offsite';

export type MyAppRow = {
  listingId: string;
  slug: string;
  name: string;
  /** Seeds the placeholder monogram, so a missing icon matches the store card's. */
  category: string | null;
  iconUrl: string | null;
  coverUrl: string | null;
  kind: MyAppKind;
  /** In-site path for a page app; the https external URL or the store detail for off-site. */
  launchHref: string;
  /** True → open in a new tab with `rel="noopener noreferrer"`. */
  external: boolean;
  lastUsedAt: Date | null;
};

export type BuildMyAppsOptions = {
  scope: StoreVisibilityScope | undefined;
  floor: ListingAudienceFloor;
  redCapable: boolean;
  /** `appBlocksPages`: without it `/apps/run` 404s and a page app launches its store page. */
  canOpenPage: boolean;
  /** Invocations before this instant do not count. */
  recentSince: Date;
  /** The viewer's "Remove from My apps" hides (slug → ISO time). Absent → nothing hidden. */
  hidden?: Readonly<HiddenApps>;
  limit?: number;
};

export type MyAppsHome = {
  /** The rows to render: hides applied, then capped. */
  apps: MyAppRow[];
  /**
   * How many rows the viewer has that a hide kept off `apps` (counted before the cap). The
   * client needs it for the empty state: with every app removed, `apps` is empty, and "No apps
   * yet" would be false.
   */
  removedCount: number;
  /** listing id → slug of exactly the rows a hide kept off `apps`; why: `my-apps-hidden.ts`. */
  removedSlugsByListingId: Record<string, string>;
};

/** True when `a` is a later instant than `b`; a null never wins, and anything beats null. */
function isLater(a: Date | null, b: Date | null): boolean {
  if (a == null) return false;
  if (b == null) return true;
  return a.getTime() > b.getTime();
}

/** Record `at` for `key`, keeping the most recent instant seen across every source. */
function touch(map: Map<string, Date | null>, key: string, at: Date | null): void {
  if (!map.has(key) || isLater(at, map.get(key) ?? null)) map.set(key, at);
}

/** `lastUsedAt` desc, nulls last, then name, then id so the order is total. */
export function compareMyApps(a: MyAppRow, b: MyAppRow): number {
  const at = a.lastUsedAt?.getTime() ?? null;
  const bt = b.lastUsedAt?.getTime() ?? null;
  if (at !== bt) {
    if (at == null) return 1;
    if (bt == null) return -1;
    return bt - at;
  }
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0;
}

export function buildMyApps(
  signals: MyAppsSignals,
  candidates: ReadonlyArray<MyAppsListingCandidate>,
  opts: BuildMyAppsOptions
): MyAppsHome {
  // App Block id → most recent use, over the three page-app sources.
  const pageUse = new Map<string, Date | null>();
  for (const g of signals.grants)
    if (g.revokedAt == null) touch(pageUse, g.appBlockId, g.grantedAt);
  for (const e of signals.entitlements) {
    if (e.revokedAt == null) touch(pageUse, e.appBlockId, e.grantedAt);
  }
  const since = opts.recentSince.getTime();
  for (const i of signals.invocations) {
    if (i.appBlockId == null || i.invokedAt == null) continue;
    if (i.invokedAt.getTime() < since) continue;
    touch(pageUse, i.appBlockId, i.invokedAt);
  }
  // OAuth client id → consent time.
  const offsiteUse = new Map<string, Date | null>();
  for (const c of signals.consents) touch(offsiteUse, c.clientId, c.updatedAt);

  const byListing = new Map<string, MyAppRow>();
  for (const candidate of candidates) {
    const { card, gate } = candidate;
    const visible = storeVisibleListingRowGate({
      row: { ...gate.row, appBlock: { currentVersionDeployedAt: gate.deployedAt } },
      visibility: gate.visibility,
      scope: opts.scope,
      floor: opts.floor,
      redCapable: opts.redCapable,
      // My apps is the viewer's own launcher, not a public store surface: an r/x app they have
      // keeps showing whatever their browsing level (the host gate still applies).
      browsingLevel: allBrowsingLevelsFlag,
    });
    if (!visible) continue;

    let kind: MyAppKind;
    let lastUsedAt: Date | null;
    if (card.kindData.kind === 'onsite') {
      if (!card.kindData.hasPage) continue;
      if (candidate.appBlockId == null || !pageUse.has(candidate.appBlockId)) continue;
      kind = 'page';
      lastUsedAt = pageUse.get(candidate.appBlockId) ?? null;
    } else {
      if (candidate.connectClientId == null || !offsiteUse.has(candidate.connectClientId)) continue;
      kind = 'offsite';
      lastUsedAt = offsiteUse.get(candidate.connectClientId) ?? null;
    }

    const cta = getListingCta(card, { canOpenPage: opts.canOpenPage });
    const row: MyAppRow = {
      listingId: card.id,
      slug: card.slug,
      name: card.name,
      category: card.category,
      iconUrl: card.iconUrl,
      coverUrl: card.coverUrl,
      kind,
      launchHref: cta.href,
      external: cta.external,
      lastUsedAt,
    };
    const existing = byListing.get(card.id);
    if (!existing || isLater(row.lastUsedAt, existing.lastUsedAt)) byListing.set(card.id, row);
  }

  const hidden = opts.hidden ?? {};
  const shown: MyAppRow[] = [];
  const removedSlugsByListingId: Record<string, string> = {};
  let removedCount = 0;
  for (const row of [...byListing.values()].sort(compareMyApps)) {
    // Own-property lookup: a slug like `constructor` must not read Object.prototype.
    const hiddenAt = Object.prototype.hasOwnProperty.call(hidden, row.slug)
      ? hidden[row.slug]
      : undefined;
    if (isHiddenFromHome(hiddenAt, row.lastUsedAt?.getTime() ?? null)) {
      removedCount++;
      removedSlugsByListingId[row.listingId] = row.slug;
    } else shown.push(row);
  }
  return {
    apps: shown.slice(0, opts.limit ?? MY_APPS_MAX_ROWS),
    removedCount,
    removedSlugsByListingId,
  };
}
