import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteRequestError,
  getMyListingForApp,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * `getMyListingForApp` — the owner-gated `appBlockId` → `AppListing.id` resolver
 * for the on-site listing-media owner page. Covers the three contract branches:
 *   - owner happy-path → `{ appListingId, status, contentRating, hasPendingRevision }`
 *   - a listing owned by ANOTHER user → NOT_OWNED (router maps → FORBIDDEN)
 *   - no listing row for the app → NOT_FOUND
 * plus the pending-revision flag (a queued shadow-revision request flips it true).
 *
 * DB is fully mocked — no real Prisma. Only the two reads the function makes are
 * stubbed (`appListing.findUnique`, `appListingPublishRequest.findFirst`).
 */

const { mockRead } = vi.hoisted(() => ({
  mockRead: {
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockRead }));

const OWNER = 42;
const OTHER = 99;

beforeEach(() => {
  mockRead.appListing.findUnique.mockReset().mockResolvedValue(null);
  mockRead.appListingPublishRequest.findFirst.mockReset().mockResolvedValue(null);
});

describe('getMyListingForApp', () => {
  it('owner happy-path → returns the listing id + status + rating (no pending revision)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({
      id: 'apl_onsite',
      userId: OWNER,
      status: 'approved',
      contentRating: 'pg13',
    });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res).toEqual({
      appListingId: 'apl_onsite',
      status: 'approved',
      contentRating: 'pg13',
      hasPendingRevision: false,
    });
    // Resolved by the @unique appBlockId, not by id.
    expect(mockRead.appListing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { appBlockId: 'my-block' } })
    );
  });

  it('flags hasPendingRevision when a shadow-revision request is already queued', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({
      id: 'apl_onsite',
      userId: OWNER,
      status: 'approved',
      contentRating: 'g',
    });
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({ id: 'alpr_pending' });

    const res = await getMyListingForApp({ appBlockId: 'my-block', userId: OWNER });

    expect(res.hasPendingRevision).toBe(true);
    // The pending check is scoped to a pending request whose listing is a shadow of ours.
    expect(mockRead.appListingPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          appListing: { revisionOfId: 'apl_onsite' },
        }),
      })
    );
  });

  it('a listing owned by another user → NOT_OWNED', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({
      id: 'apl_onsite',
      userId: OTHER,
      status: 'approved',
      contentRating: 'g',
    });

    await expect(getMyListingForApp({ appBlockId: 'my-block', userId: OWNER })).rejects.toMatchObject(
      { name: 'OffsiteRequestError', code: 'NOT_OWNED' }
    );
    // Never probes the revision request once ownership fails.
    expect(mockRead.appListingPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('no listing row for the app → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);

    const err = await getMyListingForApp({ appBlockId: 'ghost', userId: OWNER }).catch((e) => e);
    expect(err).toBeInstanceOf(OffsiteRequestError);
    expect(err.code).toBe('NOT_FOUND');
  });
});
