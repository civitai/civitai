import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The seam the unit tests of `readCatalog` cannot see: that the REAL scope read is the
 * public-catalog decision, kill switch included. Replacing it with the constant scope (`full`)
 * passes every other test in this directory; it fails here.
 */

const { isFliptMock } = vi.hoisted(() => ({ isFliptMock: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: isFliptMock,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { liveCatalogReadDeps } from '~/server/registry-adapter/catalog-source.live';
import type { ListingMediaImage } from '~/server/services/blocks/listing-media-audience';
import { listingMediaImageSelect } from '~/server/services/blocks/listing-media-audience';
import {
  LISTING_COVER_WIDTH,
  LISTING_SCREENSHOT_WIDTH,
  listingCoverUrl,
  listingIconUrl,
  listingMediaEdgeUrl,
} from '~/server/services/blocks/listing-media-url';
import { PUBLIC_APPS_CATALOG_DISABLED_FLAG } from '~/server/services/blocks/public-apps-catalog';

describe('liveCatalogReadDeps().resolveScope', () => {
  beforeEach(() => isFliptMock.mockReset());

  it('🔴 the kill switch thrown → `none`', async () => {
    isFliptMock.mockImplementation(
      async (flag: string) => flag === PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
    expect(await liveCatalogReadDeps().resolveScope()).toBe('none');
  });

  it('positive control: the kill switch off → the public catalog, and the switch was read', async () => {
    isFliptMock.mockResolvedValue(false);
    expect(await liveCatalogReadDeps().resolveScope()).toBe('full');
    expect(isFliptMock.mock.calls.map(([flag]) => flag)).toContain(
      PUBLIC_APPS_CATALOG_DISABLED_FLAG
    );
  });
});

/**
 * The live `loadListingExtras` read (store-listing@v1, LISTINGS-READ-MODEL.md): the listing query,
 * the civitai.red override read and the detail reads (byline, beta note, support link, fork facts,
 * the submitting run) go to the database (the shared `dbMock`), and the extras of each listing come
 * back as the stream publishes them. Fixture values are pairwise distinct.
 */
describe('liveCatalogReadDeps({ listings: true }).loadListingExtras', () => {
  const img = (url: string, nsfwLevel: number): ListingMediaImage =>
    ({
      url,
      nsfwLevel,
      ingestion: 'Scanned',
      needsReview: null,
      poi: false,
      minor: false,
      tosViolation: false,
      acceptableMinor: false,
      blockedFor: null,
      modelRestricted: false,
    } as ListingMediaImage);
  const redRow = {
    app_listing_id: 'lst-a1',
    slot: 'cover',
    image_id: 5505,
    url: 'covers/red-e5',
    nsfw_level: NsfwLevel.XXX,
    ingestion: 'Scanned',
    needs_review: null,
    poi: false,
    minor: false,
    tos_violation: false,
    acceptable_minor: false,
    blocked_for: null,
    model_restricted: false,
  };

  it('reads each listing’s media, override and metric, and defaults a missing metric', async () => {
    let query: { where: unknown; select: Record<string, unknown> } | undefined;
    dbMock.dbRead.appListing.findMany.mockImplementation((async (args: {
      where: unknown;
      select: Record<string, unknown>;
    }) => {
      // The beta read (`readListingBetaMany`) shares the model: answered apart.
      if (args.select.isBeta) {
        return [
          { id: 'lst-a1', isBeta: true, betaMessage: 'beta-note-a1' },
          // A stale note on a listing no longer in beta is never published.
          { id: 'lst-f6', isBeta: false, betaMessage: 'stale-note-f6' },
        ];
      }
      query = args;
      // As the database answers that query: screenshots filtered and in order.
      return [
        {
          id: 'lst-a1',
          serialId: 7101,
          kind: 'onsite',
          appBlockId: 'ab-a1',
          connectClientId: null,
          connectRequestedScopes: null,
          appBlock: { approvedScopes: ['models:read:self', 'ai:write:budgeted'] },
          description: 'desc-a1',
          createdAt: new Date('2026-02-03T04:05:06.000Z'),
          icon: img('icons/own-a1', NsfwLevel.PG),
          cover: img('covers/own-b2', NsfwLevel.PG13),
          screenshots: [
            { caption: 'cap-c3', image: img('shots/c3', NsfwLevel.R) },
            { caption: null, image: img('shots/d4', NsfwLevel.X) },
          ],
          metric: null,
        },
        {
          id: 'lst-f6',
          serialId: 7202,
          kind: 'offsite',
          // An off-site row can carry a block: no scopes, no run, never forkable.
          appBlockId: 'ab-f6',
          connectClientId: 'client-f6',
          connectRequestedScopes: 1,
          appBlock: { approvedScopes: ['models:read:self'] },
          description: null,
          createdAt: new Date('2025-12-31T23:59:59.000Z'),
          icon: null,
          cover: null,
          screenshots: [],
          metric: { installCount: 37 },
        },
      ];
    }) as never);
    dbMock.dbRead.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('to_regclass')) {
        return [
          {
            present: true,
            can_select: true,
            can_insert: false,
            can_update: false,
            red_slots: true,
          },
        ];
      }
      if (sql.includes('app_listing_red_media')) return [redRow];
      if (sql.includes('issue_tracker_url')) {
        return [
          { id: 'lst-a1', issueTrackerUrl: 'https://support-a1.example/issues' },
          { id: 'lst-f6', issueTrackerUrl: null },
        ];
      }
      if (sql.includes('fork_of_commit_sha')) {
        return [
          { id: 'lst-a1', forkable: true, forkOfListingId: 'lst-parent-p9', isFork: true },
          { id: 'lst-f6', forkable: true, forkOfListingId: null, isFork: false },
        ];
      }
      if (sql.includes('DISTINCT ON')) {
        runBlocks.push(sql);
        return [
          {
            id: 'ab-a1',
            repository: 'owner-a1/repo-a1',
            repositoryId: '9001',
            repositoryOwnerId: '9002',
            sha: '0123456789abcdef0123456789abcdef01234567',
            ref: 'refs/tags/v1.4.2',
            workflowRef: 'owner-a1/repo-a1/.github/workflows/release.yml@refs/tags/v1.4.2',
            repositoryVisibility: 'public',
            runId: '9003',
          },
        ];
      }
      return [];
    }) as never);
    const runBlocks: string[] = [];
    dbMock.dbRead.appCollaborator.findMany.mockResolvedValue([
      { appListingId: 'lst-a1', userId: 8802 },
      { appListingId: 'lst-a1', userId: 8801 },
      // A banned user's seat: the user read leaves them out.
      { appListingId: 'lst-f6', userId: 8803 },
    ] as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: 8801, username: 'collab-b1', image: null, deletedAt: null },
      { id: 8802, username: 'collab-b2', image: 'https://img.example/b2.png', deletedAt: null },
    ] as never);

    const { loadListingExtras } = liveCatalogReadDeps({ listings: true });
    if (!loadListingExtras) throw new Error('listings on, but no loadListingExtras');
    const extras = await loadListingExtras(['lst-a1', 'lst-f6']);

    expect(query?.where).toEqual({ id: { in: ['lst-a1', 'lst-f6'] } });
    // Only screenshots with an image, in stored order with `id` breaking ties.
    expect(query?.select.screenshots).toEqual({
      where: { imageId: { not: null } },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
      select: { caption: true, image: { select: listingMediaImageSelect } },
    });
    expect(query?.select.metric).toEqual({ select: { installCount: true } });

    expect(extras.get('lst-a1')).toEqual({
      media: [
        {
          slot: 'icon',
          host: 'any',
          url: listingIconUrl({ url: 'icons/own-a1' }),
          nsfwLevel: 1,
          rating: 'pg',
        },
        {
          slot: 'cover',
          host: 'any',
          url: listingCoverUrl({ url: 'covers/own-b2' }, null),
          nsfwLevel: 2,
          rating: 'pg13',
        },
        {
          slot: 'screenshot',
          host: 'any',
          url: listingMediaEdgeUrl('shots/c3', LISTING_SCREENSHOT_WIDTH),
          nsfwLevel: 4,
          rating: 'r',
          caption: 'cap-c3',
          coverUrl: listingMediaEdgeUrl('shots/c3', LISTING_COVER_WIDTH),
        },
        {
          slot: 'screenshot',
          host: 'any',
          url: listingMediaEdgeUrl('shots/d4', LISTING_SCREENSHOT_WIDTH),
          nsfwLevel: 8,
          rating: 'x',
          caption: null,
          coverUrl: listingMediaEdgeUrl('shots/d4', LISTING_COVER_WIDTH),
        },
        // The civitai.red cover override, red-only, rated XXX on its own (not folded into X).
        {
          slot: 'cover',
          host: 'red',
          url: listingCoverUrl({ url: 'covers/red-e5' }, null),
          nsfwLevel: 16,
          rating: 'xxx',
        },
      ],
      description: 'desc-a1',
      // No metric row yet: no installs.
      installCount: 0,
      createdAt: '2026-02-03T04:05:06.000Z',
      serialId: 7101,
      // In seat order, not the user read's order.
      collaborators: [
        { id: 8802, username: 'collab-b2', image: 'https://img.example/b2.png' },
        { id: 8801, username: 'collab-b1', image: null },
      ],
      scopes: ['models:read:self', 'ai:write:budgeted'],
      connectScopes: [],
      issueTrackerUrl: 'https://support-a1.example/issues',
      actionsRunSource: {
        repository: 'owner-a1/repo-a1',
        tag: 'v1.4.2',
        sha: '0123456789abcdef0123456789abcdef01234567',
      },
      betaMessage: 'beta-note-a1',
      forkable: true,
      // On-site: no connect client is published.
      connectClientId: null,
      fork: { isFork: true, forkOfListingId: 'lst-parent-p9' },
    });
    // Positive control for the default: a metric row's count is carried.
    expect(extras.get('lst-f6')).toEqual({
      media: [],
      description: null,
      installCount: 37,
      createdAt: '2025-12-31T23:59:59.000Z',
      serialId: 7202,
      collaborators: [],
      scopes: [],
      // UserRead, decoded by the detail's own table, because the listing has a connect client.
      connectScopes: ['UserRead'],
      issueTrackerUrl: null,
      actionsRunSource: null,
      betaMessage: null,
      forkable: false,
      connectClientId: 'client-f6',
      fork: { isFork: false, forkOfListingId: null },
    });
    // The run read asks only for the on-site listing's block.
    expect(runBlocks).toHaveLength(1);
  });
});
