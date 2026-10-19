import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: (slug: string) => `https://forgejo.example/review/${slug}`,
  repoCommitUrl: (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`,
}));
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (src: string, opts?: { width?: number }) => `edge:${src}@${opts?.width ?? 'auto'}`,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { listPendingOffsiteRequests } from '~/server/services/blocks/offsite-listing.service';
import { listPendingRequests } from '~/server/services/blocks/publish-request.service';
import { createSplitDb, type SplitDb } from './listing-media-split.harness';

/**
 * Both moderator queues carry each listing's REVIEW MEDIA — its icon and cover with their levels,
 * and its civitai.red overrides — through to the row, which is what the queue's click-to-reveal
 * blurs by on civitai.com and what the review page's override tiles show. A row that lost it
 * would render an above-SFW icon UNBLURRED (the reveal shows what it is not told to hold back).
 * The overrides are real SQL (PGlite, both real migrations, read through the READ client); the
 * queue rows are the shared Prisma mock.
 *
 * Ids: listings `apl_q_off` / `apl_q_on`, icons 131 (R) / 141 (X), covers 132 / 142 (PG),
 * overrides 133 (XXX) / 143 (PG-13) — pairwise distinct.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

let split: SplitDb;
beforeAll(async () => {
  split = await createSplitDb();
  await split.applyMigration();
  await split.applyRedSlotsMigration();
});
afterAll(() => split.db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await split.db.exec(`TRUNCATE app_listing_red_media, app_listings, "Image", "User" CASCADE`);
  await split.seed({ listingIds: ['apl_q_off', 'apl_q_on'] });
  await split.seedImages([
    { id: 133, nsfwLevel: NsfwLevel.XXX, url: 'red-off.png' },
    { id: 143, nsfwLevel: NsfwLevel.PG13, url: 'red-on.png' },
  ]);
  await split.setRedSlots('apl_q_off', { icon: 133, cover: null });
  await split.setRedSlots('apl_q_on', { icon: null, cover: 143 });
  split.route(dbMock.dbRead as never);
});

describe('the off-site / listing-media queue', () => {
  it('🔴 a row carries its review media: own icon with its level, and its civitai.red override', async () => {
    dbMock.dbRead.appListingPublishRequest.findMany.mockResolvedValue([
      {
        id: 'alpr_q_off',
        appListingId: 'apl_q_off',
        kind: 'offsite',
        slug: 'q-off',
        status: 'pending',
        submittedAt: new Date('2026-03-01T00:00:00Z'),
        appListing: {
          name: 'Q Off',
          kind: 'offsite',
          icon: { id: 131, url: 'icon-off.png', nsfwLevel: NsfwLevel.R },
          cover: { id: 132, url: 'cover-off.png', nsfwLevel: NsfwLevel.PG },
          metric: null,
        },
        submittedBy: null,
      },
    ]);
    const { items } = await listPendingOffsiteRequests({});
    expect(items[0].reviewMedia).toEqual({
      icon: { imageId: 131, url: 'edge:icon-off.png@256', nsfwLevel: NsfwLevel.R },
      cover: { imageId: 132, url: 'edge:cover-off.png@1200', nsfwLevel: NsfwLevel.PG },
      redIcon: { imageId: 133, url: 'edge:red-off.png@256', nsfwLevel: NsfwLevel.XXX },
      redCover: null,
    });
  });
});

describe('the on-site (app version) queue', () => {
  it('🔴 a row carries the review media of the listing it belongs to', async () => {
    dbMock.dbRead.appBlockPublishRequest.findMany.mockResolvedValue([
      {
        id: 'pubreq_q_on',
        appBlockId: null,
        slug: 'q-on',
        version: '1.0.0',
        submittedAt: new Date('2026-03-01T00:00:00Z'),
        bundleSizeBytes: BigInt(2048),
        bundleSha256: 'sha',
        manifest: {},
        fileSummary: {},
        manifestDiffSummary: {},
        forgejoCommitSha: null,
        submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
      },
    ]);
    dbMock.dbRead.appListing.findMany.mockImplementation(
      async (args: { where?: { slug?: unknown } }) =>
        args?.where?.slug
          ? [
              {
                id: 'apl_q_on',
                status: 'draft',
                contentRating: 'g',
                slug: 'q-on',
                kind: 'onsite',
                appBlockId: null,
                userId: 7,
                icon: { id: 141, url: 'icon-on.png', nsfwLevel: NsfwLevel.X },
                cover: { id: 142, url: 'cover-on.png', nsfwLevel: NsfwLevel.PG },
                metric: { openCount: 3 },
              },
            ]
          : []
    );
    const { items } = await listPendingRequests({ limit: 10 });
    expect(items[0].reviewMedia).toEqual({
      icon: { imageId: 141, url: 'edge:icon-on.png@256', nsfwLevel: NsfwLevel.X },
      cover: { imageId: 142, url: 'edge:cover-on.png@1200', nsfwLevel: NsfwLevel.PG },
      redIcon: null,
      redCover: { imageId: 143, url: 'edge:red-on.png@1200', nsfwLevel: NsfwLevel.PG13 },
    });
    // 🔴 The mock answers whatever was selected, so pin the select itself: without `nsfwLevel`
    // the level would read as "not rated yet", which the reveal does not hold back. (The
    // row type is cast, so tsc cannot see a dropped column here.)
    const select = (
      dbMock.dbRead.appListing.findMany.mock.calls.find(
        (c: { where?: { slug?: unknown } }[]) => c[0]?.where?.slug
      )?.[0] as { select: Record<string, unknown> }
    ).select;
    expect(select.icon).toEqual({ select: { id: true, url: true, nsfwLevel: true } });
    expect(select.cover).toEqual({ select: { id: true, url: true, nsfwLevel: true } });
  });
});
