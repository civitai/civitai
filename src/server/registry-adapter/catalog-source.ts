/**
 * One read of everything the adapter publishes: the public catalog, then, for each listed
 * on-site app, its block (id ↔ slug, the enforced manifest) and its approved publish requests.
 *
 * The reads are passed in (`catalog-source.live.ts` wires the real services), so the order of
 * decisions here — the public-catalog scope first, an empty catalog when it is withheld — can be
 * tested without a database.
 */
import type { ListingMediaItem } from '~/server/registry-adapter/catalog-media';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import type {
  ListingActionsRunSource,
  ListingCard,
  ListingCreatorChip,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

export type CatalogListing = {
  id: string;
  slug: string;
  kind: 'onsite' | 'offsite';
  name: string;
  tagline: string | null;
  category: string | null;
  contentRating: string | null;
  creatorUsername: string | null;
  appBlockId: string | null;
  externalUrl: string | null;
  /** The card's store fields, only when the listing stream is on ({@link listingFromCard}). */
  store?: ListingStoreCard;
};

/**
 * The store card fields a listing entity carries (`listing-stream.ts`), from the same catalog read.
 * Never the card's icon or cover: their ceiling follows the reader's levels, and the catalog is
 * read with every level, so the listing's media come from {@link ListingExtras} instead.
 */
export type ListingStoreCard = {
  /** The listing id: the card's key, and the store's tie-break in every sort. */
  id: string;
  /** On-site only: the card's `kindData.appBlockId` (null off-site). */
  appBlockId: string | null;
  creator: ListingCreatorChip | null;
  recommend: ListingRecommendRollup;
  reviewCount: number;
  isBeta: boolean;
  isOfficial: boolean;
  openCount: number | null;
  updatedAt: string | null;
  /** On-site only (false and null off-site). */
  hasPage: boolean;
  liveUrl: string | null;
};

/**
 * What the listing read adds per listing: its media, each rated on its own, and what no card has.
 * The detail fields are the public detail's (`getListingDetail` → `projectListingDetail`), by the
 * same rules (`catalog-source.live.ts`); none is viewer-scoped except the fork parent, which
 * {@link readCatalog} resolves.
 */
export type ListingExtras = {
  description: string | null;
  media: ListingMediaItem[];
  installCount: number;
  createdAt: string;
  serialId: number;
  collaborators: ListingCreatorChip[];
  scopes: string[];
  connectScopes: string[];
  issueTrackerUrl: string | null;
  actionsRunSource: ListingActionsRunSource | null;
  betaMessage: string | null;
  forkable: boolean;
  /** Off-site only: the public OAuth client id the detail's `kindData` carries (null otherwise). */
  connectClientId: string | null;
  /** The listing's fork facts (`readListingForkProvenance`); {@link readCatalog} names the parent. */
  fork: { isFork: boolean; forkOfListingId: string | null };
};

/**
 * Where a fork came from, as the stream may say it: `slug` is the parent's app slug when the parent
 * is in the same public catalog, else null (a parent that is hidden or gone reads the same). The
 * read model resolves it per viewer, as `getListingDetail` does (`resolveForkAttribution`).
 */
export type ListingStreamForkOf = { slug: string | null };

export type ListingStoreFields = ListingStoreCard &
  Omit<ListingExtras, 'fork'> & { forkOf: ListingStreamForkOf | null };

/**
 * A listing's {@link ListingStreamForkOf}: null unless it is a fork, and its parent named by the
 * rule the app entity's `forkOf` uses: only when the parent is in the same catalog (`slugById`, the
 * snapshot's public slugs), never itself.
 */
export function streamForkOf(
  listingId: string,
  fork: ListingExtras['fork'],
  slugById: ReadonlyMap<string, string>
): ListingStreamForkOf | null {
  if (!fork.isFork) return null;
  const parentId = fork.forkOfListingId;
  const slug = parentId !== null && parentId !== listingId ? slugById.get(parentId) : undefined;
  return { slug: slug ?? null };
}

function storeCardFields(card: ListingCard): ListingStoreCard {
  const onsite = card.kindData.kind === 'onsite' ? card.kindData : null;
  return {
    id: card.id,
    appBlockId: onsite?.appBlockId ?? null,
    creator: card.creator ? { ...card.creator } : null,
    recommend: { ...card.recommend },
    reviewCount: card.reviewCount,
    isBeta: card.isBeta,
    isOfficial: card.isOfficial === true,
    openCount: card.openCount,
    updatedAt: card.updatedAt ?? null,
    hasPage: onsite?.hasPage ?? false,
    liveUrl: onsite?.liveUrl ?? null,
  };
}

/**
 * The fields a store card contributes. The card's own kind data says which block, or which link.
 * `store` (the listing stream on) adds the card's store fields; without it the creator's id and
 * the stats never enter the catalog.
 */
export function listingFromCard(
  card: ListingCard,
  { store = false }: { store?: boolean } = {}
): CatalogListing {
  return {
    ...(store ? { store: storeCardFields(card) } : {}),
    id: card.id,
    slug: card.slug,
    kind: card.kind,
    name: card.name,
    tagline: card.tagline,
    category: card.category,
    contentRating: card.contentRating,
    creatorUsername: card.creator?.username ?? null,
    appBlockId: card.kindData.kind === 'onsite' ? card.kindData.appBlockId : null,
    externalUrl: card.kindData.kind === 'offsite' ? card.kindData.externalUrl : null,
  };
}

export type CatalogBlock = NonNullable<CatalogApp['block']>;

export type CatalogApprovedRequest = CatalogApp['approved'][number] & { appBlockId: string };

export type CatalogReadDeps = {
  /** The public-catalog decision for this caller: `none` while the grant is withheld. */
  resolveScope: () => Promise<StoreVisibilityScope>;
  listPage: (
    scope: StoreVisibilityScope,
    cursor: string | undefined
  ) => Promise<{ items: CatalogListing[]; nextCursor?: string }>;
  loadBlocks: (ids: string[]) => Promise<CatalogBlock[]>;
  loadApproved: (appBlockIds: string[]) => Promise<CatalogApprovedRequest[]>;
  /** Listing id → its public source-repo link, for the listings given; absent means none. */
  loadSourceRepoUrls: (listingIds: string[]) => Promise<Map<string, string | null>>;
  /**
   * Fork listing id → the listing id it was forked from, for the forks among the listings given.
   * Ids only: never used to read a parent.
   */
  loadForkParents: (listingIds: string[]) => Promise<Map<string, string>>;
  /**
   * Listing id → the icon its app entity publishes, gated at the listing's own rating
   * (`registryIconUrl`); absent means none. Never the store card's icon, whose ceiling follows
   * the reader's levels.
   */
  loadIconUrls: (listingIds: string[]) => Promise<Map<string, string | null>>;
  /** Listing id → its {@link ListingExtras}; read only while the listing stream is on. */
  loadListingExtras?: (listingIds: string[]) => Promise<Map<string, ListingExtras>>;
};

/** Pages the catalog may take before the read fails. A truncated catalog would read as deletes. */
export const MAX_CATALOG_PAGES = 200;

/**
 * One catalog read. `listingsFailed`: the listing stream is on and its read failed, so the apps
 * carry no store fields; only the listing stream is unavailable (`buildEntities`), never read as
 * every listing deleted.
 */
export type CatalogRead = CatalogApp[] & { listingsFailed?: true };

/**
 * `listings`: the listing stream is on, so each app also carries its store fields, a listing's
 * card fields joined with its {@link ListingExtras}. A listing missing either carries none, and
 * publishes no listing entity. A failed listing read is passed to `onError` and fails only the
 * listing stream ({@link CatalogRead}); every other stream is read as without it.
 */
export async function readCatalog(
  deps: CatalogReadDeps,
  {
    listings: listingStream = false,
    onError,
  }: { listings?: boolean; onError?: (err: unknown) => void } = {}
): Promise<CatalogRead> {
  const scope = await deps.resolveScope();
  if (scope === 'none') return [];

  const listings: CatalogListing[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_CATALOG_PAGES) {
      throw new Error(`catalog read exceeded ${MAX_CATALOG_PAGES} pages`);
    }
    const { items, nextCursor } = await deps.listPage(scope, cursor);
    listings.push(...items);
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  const blockIds = [
    ...new Set(
      listings.flatMap((l) => (l.kind === 'onsite' && l.appBlockId ? [l.appBlockId] : []))
    ),
  ];
  const [blocks, approved] = blockIds.length
    ? await Promise.all([deps.loadBlocks(blockIds), deps.loadApproved(blockIds)])
    : [[], []];
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const approvedByBlock = new Map<string, CatalogApprovedRequest[]>();
  for (const r of approved) {
    const list = approvedByBlock.get(r.appBlockId) ?? [];
    list.push(r);
    approvedByBlock.set(r.appBlockId, list);
  }
  const reviewOrder = (a: CatalogApprovedRequest, b: CatalogApprovedRequest) => {
    const at = (a.reviewedAt?.getTime() ?? 0) - (b.reviewedAt?.getTime() ?? 0);
    return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  const blockOf = (l: CatalogListing) =>
    l.kind === 'onsite' && l.appBlockId ? blockById.get(l.appBlockId) ?? null : null;
  // A parent is named only when it is in THIS snapshot, i.e. it passed the same public-catalog
  // gate. A parent outside it (private, removed, unapproved, deleted) is never looked up, so its
  // slug cannot leave through a fork.
  const publicSlugById = new Map(listings.map((l) => [l.id, blockOf(l)?.blockId ?? l.slug]));

  // One query each for the whole catalog, keyed by listing id, as the blocks and requests are.
  const listingIds = listings.map((l) => l.id);
  // Its own failure, caught here so it never fails the reads beside it: null is "failed".
  const readExtras = async (): Promise<Map<string, ListingExtras> | null> => {
    if (!listingStream || !listingIds.length) return new Map();
    try {
      if (!deps.loadListingExtras) {
        throw new Error('the listing stream is on but the catalog has no listing read');
      }
      return await deps.loadListingExtras(listingIds);
    } catch (err) {
      onError?.(err);
      return null;
    }
  };
  const [sourceRepoUrls, forkParents, iconUrls, extras] = listingIds.length
    ? await Promise.all([
        deps.loadSourceRepoUrls(listingIds),
        deps.loadForkParents(listingIds),
        deps.loadIconUrls(listingIds),
        readExtras(),
      ])
    : [
        new Map<string, string | null>(),
        new Map<string, string>(),
        new Map<string, string | null>(),
        new Map<string, ListingExtras>(),
      ];
  const storeOf = (l: CatalogListing): ListingStoreFields | undefined => {
    const more = extras?.get(l.id);
    if (!listingStream || !l.store || !more) return undefined;
    const { fork, ...rest } = more;
    return { ...l.store, ...rest, forkOf: streamForkOf(l.id, fork, publicSlugById) };
  };

  const apps: CatalogRead = [];
  if (extras === null) apps.listingsFailed = true;
  for (const l of listings) {
    const block = blockOf(l);
    const parentId = forkParents.get(l.id) ?? null;
    apps.push({
      listing: {
        slug: l.slug,
        kind: l.kind,
        name: l.name,
        tagline: l.tagline,
        category: l.category,
        contentRating: l.contentRating,
        iconUrl: iconUrls.get(l.id) ?? null,
        creatorUsername: l.creatorUsername,
        externalUrl: l.kind === 'offsite' ? l.externalUrl : null,
        sourceRepoUrl: sourceRepoUrls.get(l.id) ?? null,
        forkOf: (parentId !== null && parentId !== l.id && publicSlugById.get(parentId)) || null,
        ...(listingStream ? { store: storeOf(l) } : {}),
      },
      block,
      approved: block
        ? (approvedByBlock.get(block.id) ?? [])
            .sort(reviewOrder)
            .map(({ appBlockId: _appBlockId, ...r }) => r)
        : [],
    });
  }
  return apps;
}
