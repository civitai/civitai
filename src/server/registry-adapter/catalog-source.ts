/**
 * One read of everything the adapter publishes: the public catalog, then, for each listed
 * on-site app, its block (id ↔ slug, the enforced manifest) and its approved publish requests.
 *
 * The reads are passed in (`catalog-source.live.ts` wires the real services), so the order of
 * decisions here — the public-catalog scope first, an empty catalog when it is withheld — can be
 * tested without a database.
 */
import type { CatalogApp } from '~/server/registry-adapter/entities';
import type { ListingCard } from '~/server/schema/blocks/app-listing-read.schema';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';

export type CatalogListing = {
  id: string;
  slug: string;
  kind: 'onsite' | 'offsite';
  name: string;
  tagline: string | null;
  category: string | null;
  contentRating: string | null;
  iconUrl: string | null;
  creatorUsername: string | null;
  appBlockId: string | null;
  externalUrl: string | null;
};

/** The fields a store card contributes. The card's own kind data says which block, or which link. */
export function listingFromCard(card: ListingCard): CatalogListing {
  return {
    id: card.id,
    slug: card.slug,
    kind: card.kind,
    name: card.name,
    tagline: card.tagline,
    category: card.category,
    contentRating: card.contentRating,
    iconUrl: card.iconUrl,
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
  loadSourceRepoUrl: (listingId: string) => Promise<string | null>;
};

/** Pages the catalog may take before the read fails. A truncated catalog would read as deletes. */
export const MAX_CATALOG_PAGES = 200;

export async function readCatalog(deps: CatalogReadDeps): Promise<CatalogApp[]> {
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

  const apps: CatalogApp[] = [];
  for (const l of listings) {
    const block = l.kind === 'onsite' && l.appBlockId ? blockById.get(l.appBlockId) ?? null : null;
    apps.push({
      listing: {
        slug: l.slug,
        kind: l.kind,
        name: l.name,
        tagline: l.tagline,
        category: l.category,
        contentRating: l.contentRating,
        iconUrl: l.iconUrl,
        creatorUsername: l.creatorUsername,
        externalUrl: l.kind === 'offsite' ? l.externalUrl : null,
        sourceRepoUrl: await deps.loadSourceRepoUrl(l.id),
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
