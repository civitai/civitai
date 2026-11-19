/**
 * The real reads behind {@link CatalogReadDeps}. Read-only: the catalog through the store's own
 * listing service, everything else through the read client.
 */
import { dbRead } from '~/server/db/client';
import type { CatalogReadDeps } from '~/server/registry-adapter/catalog-source';
import { listingFromCard } from '~/server/registry-adapter/catalog-source';
import { registryIconUrl } from '~/server/registry-adapter/catalog-media';
import { listingMediaImageSelect } from '~/server/services/blocks/listing-media-audience';
import { listAppListingsSchema } from '~/server/schema/blocks/app-listing-read.schema';
import { listAvailableListings } from '~/server/services/blocks/app-listing.service';
import { readListingForkParents } from '~/server/services/blocks/app-fork.service';
import { readListingSourceRepoUrls } from '~/server/services/blocks/app-listing-source-repo.service';
import { resolvePublicAppsCatalogScope } from '~/server/services/blocks/public-apps-catalog';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const PAGE_SIZE = 50;

export function liveCatalogReadDeps(): CatalogReadDeps {
  return {
    // The adapter has no principal of its own: it takes the public catalog's SCOPE as an
    // anonymous caller would, so the kill switch and visibility levels apply. Its RATING rule is
    // deliberately different from the anonymous REST catalog's (below).
    resolveScope: () => resolvePublicAppsCatalogScope(undefined, 'registry-adapter'),

    async listPage(scope, cursor) {
      // `newest` keys on creation time, which never changes, so a listing renamed mid-read
      // cannot slip past a page boundary and read as a delete.
      const input = listAppListingsSchema.parse({
        kind: 'all',
        sort: 'newest',
        limit: PAGE_SIZE,
        cursor,
      });
      const { items, nextCursor } = await listAvailableListings(input, {
        scope,
        floor: 'public',
        // Every content rating is published, each entity tagged with its rating, and consumers
        // filter. So the mature gate is opened the way a mature-capable host opens it for a viewer
        // whose level includes R and X — unlike the anonymous REST catalog, which shows PG only.
        redCapable: true,
        viewerBrowsingLevel: allBrowsingLevelsFlag,
      });
      return { nextCursor, items: items.map(listingFromCard) };
    },

    loadBlocks: (ids) =>
      dbRead.appBlock.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          blockId: true,
          version: true,
          status: true,
          contentRating: true,
          manifest: true,
        },
      }),

    async loadApproved(appBlockIds) {
      const rows = await dbRead.appBlockPublishRequest.findMany({
        where: { appBlockId: { in: appBlockIds }, status: 'approved' },
        select: {
          id: true,
          appBlockId: true,
          version: true,
          manifest: true,
          bundleSha256: true,
          forgejoCommitSha: true,
          sourceCommit: true,
          reviewedAt: true,
        },
      });
      return rows.flatMap(({ appBlockId, forgejoCommitSha, ...r }) =>
        appBlockId ? [{ ...r, appBlockId, commitSha: forgejoCommitSha }] : []
      );
    },

    loadSourceRepoUrls: (listingIds) => readListingSourceRepoUrls(listingIds, dbRead),

    // The listings' own fork pointers only; readCatalog decides whether a parent may be named.
    loadForkParents: (listingIds) => readListingForkParents(listingIds, dbRead),

    // The listings' own icons with the gate's columns, gated at each listing's own rating; the
    // civitai.red overrides are never read.
    async loadIconUrls(listingIds) {
      const rows = await dbRead.appListing.findMany({
        where: { id: { in: listingIds } },
        select: { id: true, contentRating: true, icon: { select: listingMediaImageSelect } },
      });
      return new Map(rows.map((r) => [r.id, registryIconUrl(r)]));
    },
  };
}
