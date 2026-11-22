/**
 * The real reads behind {@link CatalogReadDeps}. Read-only: the catalog through the store's own
 * listing service, everything else through the read client.
 */
import { dbRead } from '~/server/db/client';
import type { CatalogReadDeps, ListingExtras } from '~/server/registry-adapter/catalog-source';
import { listingFromCard } from '~/server/registry-adapter/catalog-source';
import { registryIconUrl, registryListingMedia } from '~/server/registry-adapter/catalog-media';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import { listingMediaImageSelect } from '~/server/services/blocks/listing-media-audience';
import type { ListingRedMediaImages } from '~/server/services/blocks/listing-media-split.service';
import { readListingRedMediaManyForRender } from '~/server/services/blocks/listing-media-split.service';
import type { ListingActionsRunSource } from '~/server/schema/blocks/app-listing-read.schema';
import { listAppListingsSchema } from '~/server/schema/blocks/app-listing-read.schema';
import {
  listAvailableListings,
  listingDetailConnectScopes,
  listingDetailScopes,
  listingHydrateSelect,
  loadDisplayedCollaboratorChipsMany,
  publicBetaMessage,
  publicConnectClientId,
  publicForkable,
} from '~/server/services/blocks/app-listing.service';
import { readLiveActionsRunSourcesForBlocks } from '~/server/services/blocks/actions-run-source.service';
import type { ListingForkProvenance } from '~/server/services/blocks/app-fork.service';
import {
  NO_FORK_PROVENANCE,
  readListingForkParents,
  readListingForkProvenanceMany,
} from '~/server/services/blocks/app-fork.service';
import { readListingBetaManyForRender } from '~/server/services/blocks/app-listing-beta.service';
import { readListingIssueTrackerUrlsForRender } from '~/server/services/blocks/app-listing-issue-tracker.service';
import { readListingSourceRepoUrls } from '~/server/services/blocks/app-listing-source-repo.service';
import { resolvePublicAppsCatalogScope } from '~/server/services/blocks/public-apps-catalog';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const PAGE_SIZE = 50;

/** The listing columns {@link listingExtrasFromRow} reads, as `loadListingExtras` selects them. */
export type ListingExtrasRow = {
  id: string;
  serialId: number;
  kind: string;
  appBlockId: string | null;
  connectClientId: string | null;
  connectRequestedScopes: number | null;
  description: string | null;
  createdAt: Date;
  icon: ListingMediaImage | null;
  cover: ListingMediaImage | null;
  screenshots: Array<{ caption: string | null; image: ListingMediaImage | null }>;
  appBlock: { approvedScopes: unknown } | null;
  metric: { installCount: number } | null;
};

/**
 * One listing's {@link ListingExtras} from its row and the batched reads beside it, by the public
 * detail's own rules: what an anonymous viewer's `getListingDetail` shows, less the fork parent,
 * which `readCatalog` names. `run` is the submitting run of the block an on-site listing serves.
 */
export function listingExtrasFromRow(
  r: ListingExtrasRow,
  reads: {
    red: ListingRedMediaImages | null;
    collaborators: Array<{ id: number; username: string | null; image: string | null }>;
    beta: { isBeta: boolean; betaMessage: string | null } | null;
    issueTrackerUrl: string | null;
    fork: ListingForkProvenance;
    run: ListingActionsRunSource | null;
  }
): ListingExtras {
  return {
    media: registryListingMedia({ ...r, red: reads.red }),
    description: r.description ?? null,
    installCount: r.metric?.installCount ?? 0,
    createdAt: r.createdAt.toISOString(),
    serialId: r.serialId,
    collaborators: reads.collaborators.map((chip) => ({
      id: chip.id,
      username: chip.username ?? null,
      image: chip.image ?? null,
    })),
    scopes: listingDetailScopes(r),
    connectScopes: listingDetailConnectScopes(r, r.connectRequestedScopes),
    issueTrackerUrl: reads.issueTrackerUrl,
    actionsRunSource: r.kind === 'onsite' ? reads.run : null,
    betaMessage: publicBetaMessage(reads.beta ?? { isBeta: false, betaMessage: null }),
    forkable: publicForkable(r.kind, reads.fork.forkable),
    connectClientId: publicConnectClientId(r),
    fork: { isFork: reads.fork.isFork, forkOfListingId: reads.fork.forkOfListingId },
  };
}

/** `listings`: the listing stream is on, so the cards keep their store fields and extras are read. */
export function liveCatalogReadDeps({
  listings = false,
}: { listings?: boolean } = {}): CatalogReadDeps {
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
      return { nextCursor, items: items.map((card) => listingFromCard(card, { store: listings })) };
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

    // Only while the listing stream is on: one query per field for the whole catalog, never one per
    // listing. The icon, cover and screenshots are the store's own selects (`listingHydrateSelect`),
    // so the stream reads the same images, screenshot filter and order as the card and detail it
    // mirrors. Only those pieces: the whole select reads columns the stream never carries (the
    // manifest), and its metric piece reads four counters where one is needed. The detail fields
    // go through the detail's own rules (`listingDetailScopes`, `listingDetailConnectScopes`,
    // `publicBetaMessage`, `publicConnectClientId`) and the batched forms of its reads.
    ...(listings
      ? {
          async loadListingExtras(listingIds: string[]) {
            const [rows, red, collaborators, beta, issueTrackers, forks] = await Promise.all([
              dbRead.appListing.findMany({
                where: { id: { in: listingIds } },
                select: {
                  id: true,
                  serialId: true,
                  kind: true,
                  appBlockId: true,
                  connectClientId: true,
                  connectRequestedScopes: true,
                  description: true,
                  createdAt: true,
                  icon: listingHydrateSelect.icon,
                  cover: listingHydrateSelect.cover,
                  screenshots: listingHydrateSelect.screenshots,
                  appBlock: { select: { approvedScopes: true } },
                  metric: { select: { installCount: true } },
                },
              }),
              readListingRedMediaManyForRender(dbRead, listingIds),
              loadDisplayedCollaboratorChipsMany(listingIds),
              readListingBetaManyForRender(listingIds, dbRead),
              readListingIssueTrackerUrlsForRender(listingIds, dbRead),
              readListingForkProvenanceMany(listingIds, dbRead),
            ]);
            // On-site apps only, as the detail reads it: an off-site listing has no submitted bundle.
            const runs = await readLiveActionsRunSourcesForBlocks(
              dbRead,
              rows.flatMap((r) => (r.kind === 'onsite' && r.appBlockId ? [r.appBlockId] : []))
            );
            return new Map(
              rows.map((r) => [
                r.id,
                listingExtrasFromRow(r, {
                  red: red.get(r.id) ?? null,
                  collaborators: collaborators.get(r.id) ?? [],
                  beta: beta.get(r.id) ?? null,
                  issueTrackerUrl: issueTrackers.get(r.id) ?? null,
                  fork: forks.get(r.id) ?? NO_FORK_PROVENANCE,
                  run: (r.kind === 'onsite' && r.appBlockId && runs.get(r.appBlockId)) || null,
                }),
              ])
            );
          },
        }
      : {}),
  };
}
