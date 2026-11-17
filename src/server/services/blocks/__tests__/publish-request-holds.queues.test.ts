import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  reviewRepoUrl: (slug: string) => `https://forgejo.example/review/${slug}`,
  repoCommitUrl: (slug: string, ref: string) => `https://forgejo.example/${slug}/commit/${ref}`,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { listPendingOffsiteRequests } from '~/server/services/blocks/offsite-listing.service';
import { listPendingRequests } from '~/server/services/blocks/publish-request.service';

/**
 * Both moderator queues carry each row's open-hold count from the holds table, keyed by the app's
 * slug. It is the moderator's only warning before approve and what keeps a held app out of the
 * fast lane, so an unreadable table reads as unknown (`null`), never as clean (0).
 * Row ids and slugs differ on purpose, so a lookup by id finds nothing.
 */

function answerHoldCounts(result: { slug: string; n: number }[] | Error) {
  dbMock.dbRead.$queryRaw.mockImplementation((async (strings: unknown) => {
    const sql = Array.isArray(strings) ? strings.join('?') : '';
    if (!sql.includes('app_publish_request_holds')) return [];
    if (result instanceof Error) throw result;
    return result;
  }) as never);
}

const onsiteRow = (id: string, slug: string) => ({
  id,
  appBlockId: null,
  slug,
  version: '1.0.0',
  submittedAt: new Date('2026-03-01T00:00:00Z'),
  bundleSizeBytes: BigInt(2048),
  bundleSha256: 'sha',
  manifest: {},
  fileSummary: {},
  manifestDiffSummary: {},
  forgejoCommitSha: null,
  submittedBy: { id: 7, username: 'author', deletedAt: null, image: null },
});

const offsiteRow = (id: string, slug: string) => ({
  id,
  appListingId: `apl_${slug}`,
  kind: 'offsite',
  slug,
  status: 'pending',
  submittedAt: new Date('2026-03-01T00:00:00Z'),
  appListing: { name: slug, kind: 'offsite', icon: null, cover: null, metric: null },
  submittedBy: null,
});

const countsBySlug = (items: { slug: string; openHoldCount: number | null }[]) =>
  Object.fromEntries(items.map((r) => [r.slug, r.openHoldCount]));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.appBlockPublishRequest.findMany.mockResolvedValue([
    onsiteRow('pubreq_1', 'held-app'),
    onsiteRow('pubreq_2', 'clean-app'),
  ]);
  dbMock.dbRead.appListingPublishRequest.findMany.mockResolvedValue([
    offsiteRow('alpr_1', 'held-app'),
    offsiteRow('alpr_2', 'clean-app'),
  ]);
});

describe.each([
  ['on-site (app version)', async () => (await listPendingRequests({ limit: 10 })).items],
  ['off-site / listing-media', async () => (await listPendingOffsiteRequests({})).items],
])('the %s queue', (_name, list) => {
  it('🔴 a held app shows its open-hold count, an unheld one 0', async () => {
    answerHoldCounts([{ slug: 'held-app', n: 1 }]);
    expect(countsBySlug(await list())).toEqual({ 'held-app': 1, 'clean-app': 0 });
  });

  it('🔴 an unreadable holds table shows every row as unknown, never as clean', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answerHoldCounts(new Error('relation "app_publish_request_holds" does not exist'));
    expect(countsBySlug(await list())).toEqual({ 'held-app': null, 'clean-app': null });
    quiet.mockRestore();
  });
});
