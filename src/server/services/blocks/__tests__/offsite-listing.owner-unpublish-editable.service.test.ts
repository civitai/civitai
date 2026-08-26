import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMyListingForApp,
  getMyListingForEdit,
  listingMediaEditBlockedReason,
  updateListing,
} from '~/server/services/blocks/offsite-listing.service';

/**
 * App Store Listings (W13) — `removed` IS TWO STATES, AND THE EDIT PATHS MUST TELL THEM
 * APART.
 *
 * `app_listings.status = 'removed'` is written by BOTH `unpublishOwnListing` (the owner
 * takes their own app down to fix it up) and a moderator `delist`/`purge`. Every author
 * edit path refused BOTH, and told both callers a MODERATOR had done it — so an owner who
 * unpublished their own listing had no repair step at all, and was misinformed about why.
 *
 * The distinguishing signal is the listing's MOST-RECENT `AppListingModerationEvent`:
 * `owner-unpublish` ⇒ the owner's own action; anything else, or NO event, ⇒ moderator (or
 * unprovable), which stays refused. This is the same predicate `republishOwnListing`'s
 * go-live guard already used, now single-sourced in `app-listing-owner-unpublish`.
 *
 * Both directions are pinned for all three sites, plus the `!lastEvent` arm — that is a
 * real branch, not a degenerate one, and it must FAIL CLOSED.
 *
 * 🔴 RED-AT-BASE, per direction: the `owner-unpublish ⇒ editable` cases and the
 * message-attribution case fail on `origin/main`; the moderator/no-event cases are
 * INVARIANT GUARDS (green on both sides) and are labelled as such below rather than
 * counted as regression coverage.
 *
 * DB fully mocked — no real Prisma.
 */

type Row = Record<string, unknown> & { id: string };

const { mockRead, mockWrite, seq } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 0),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    appListingModerationEvent: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    image: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  });
  const mockRead = makeClient();
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite, seq: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => `edge:${url}` }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const OWNER = 42;
const LISTING_ID = 'apl_parent';

/** The one message a MODERATOR takedown is allowed to produce. Pinned as a literal. */
const MOD_TAKEDOWN_MESSAGE =
  'this listing has been removed by a moderator and can no longer be edited';

/** An owner-owned OFF-SITE listing row, as `editableListingSelect` returns it. */
function listingRow(overrides: Partial<Row> = {}): Row {
  return {
    id: LISTING_ID,
    kind: 'offsite',
    slug: 'cool-app',
    status: 'removed',
    userId: OWNER,
    revisionOfId: null,
    name: 'Cool App',
    tagline: 'the tagline',
    description: 'the description',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://cool.example.com/app',
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    ...overrides,
  };
}

/** The `loadListingEditView` projection (the `select` carrying `icon`). */
function editViewRow(): Record<string, unknown> {
  return {
    name: 'Cool App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    icon: { url: 'icon-key' },
    cover: { url: 'cover-key' },
    screenshots: [],
  };
}

/**
 * Serve `row` on every `appListing.findUnique` shape the edit paths use — the entry
 * resolve (`where.appBlockId`), the edit-view projection (`select` carries `icon`), and
 * the owned/editable + ownership + source-repo reads (everything else).
 */
function wireListing(row: Row) {
  const impl = async (args: unknown) => {
    const a = args as { select?: Record<string, unknown> };
    if ('icon' in (a.select ?? {})) return editViewRow();
    return row;
  };
  mockRead.appListing.findUnique.mockImplementation(impl);
  mockWrite.appListing.findUnique.mockImplementation(impl);
  // `getMyListingForApp`'s SLUG arm resolves through `findFirst` on the replica.
  mockRead.appListing.findFirst.mockImplementation(async (args: unknown) => {
    const a = args as { where?: { slug?: string } };
    return a.where?.slug === row.slug ? row : null;
  });
}

/**
 * Wire the listing's last moderation event on BOTH pools.
 *
 * Both, deliberately: a case that wired only the primary would pass even if the code read
 * the replica, and vice versa — so no behavioural case here is secretly a pool assertion.
 * WHICH pool the gates use is asserted on its own, by the "reads the last event from the
 * PRIMARY" case below.
 */
function wireLastModerationEvent(action: string | null) {
  const value = action == null ? null : { action };
  mockRead.appListingModerationEvent.findFirst.mockResolvedValue(value);
  mockWrite.appListingModerationEvent.findFirst.mockResolvedValue(value);
}

beforeEach(() => {
  for (const client of [mockRead, mockWrite]) {
    client.appListing.findUnique.mockReset().mockResolvedValue(null);
    client.appListing.findFirst.mockReset().mockResolvedValue(null);
    client.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    client.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    client.appCollaborator.findFirst.mockReset().mockResolvedValue(null);
    client.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
    client.appListingPublishRequest.findFirst.mockReset().mockResolvedValue(null);
    client.appListingModerationEvent.findFirst.mockReset().mockResolvedValue(null);
    client.appListingModerationEvent.findMany.mockReset().mockResolvedValue([]);
    client.image.findMany.mockReset().mockResolvedValue([]);
  }
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  seq.n = 0;
});

// ---------------------------------------------------------------------------
// updateListing — the WRITE path
// ---------------------------------------------------------------------------

describe('updateListing on a `removed` listing', () => {
  it('🔴 OWNER-UNPUBLISH ⇒ EDITABLE: the scalar patch is written IN PLACE, no re-review', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await updateListing({
      listingId: LISTING_ID,
      patch: { tagline: 'fixing this up' },
      userId: OWNER,
    });

    expect(res).toEqual({
      listingId: LISTING_ID,
      status: 'removed',
      requiresReview: false,
      shadowId: null,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING_ID },
      data: { tagline: 'fixing this up' },
    });
    // In place, exactly like draft/pending — a listing that is not being served has no
    // live copy to protect behind a shadow revision.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist stays FORBIDDEN, and keeps blaming a moderator', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a `purge` is likewise not owner-unpublish → FORBIDDEN', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('purge');

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): NO moderation events at all → FORBIDDEN (fails CLOSED)', async () => {
    // 🔴 `!lastEvent` is a real branch. Nothing proves the owner took this listing down,
    // so it must be treated as a moderator removal — never trusted to the owner.
    wireListing(listingRow());
    wireLastModerationEvent(null);

    await expect(
      updateListing({ listingId: LISTING_ID, patch: { tagline: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('🔴 reads the last event from the PRIMARY, newest-first with the id tiebreak', async () => {
    // Pool: a stale replica can hide a moderator's just-written `delist` behind the
    // owner's older `owner-unpublish` and GRANT an edit that was revoked. Ordering:
    // `createdAt` alone is not a total order (same-tx events share a timestamp), so the
    // id tiebreak is what makes "most recent" deterministic.
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    await updateListing({ listingId: LISTING_ID, patch: { tagline: 'y' }, userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).toHaveBeenCalledWith({
      where: { appListingId: LISTING_ID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { action: true },
    });
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });

  it('does NOT read moderation events for a non-`removed` listing (no extra round trip)', async () => {
    wireListing(listingRow({ status: 'draft' }));

    await updateListing({ listingId: LISTING_ID, patch: { tagline: 'z' }, userId: OWNER });

    expect(mockWrite.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
    expect(mockRead.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getMyListingForEdit — the PREFILL read
// ---------------------------------------------------------------------------

describe('getMyListingForEdit on a `removed` listing', () => {
  it('🔴 OWNER-UNPUBLISH ⇒ EDITABLE: the prefill resolves instead of throwing FORBIDDEN', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER });

    expect(res).toMatchObject({ parentId: LISTING_ID, status: 'removed', shadowId: null });
    // Not approved ⇒ edited in place, so no shadow revision is minted on the prefill.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist stays FORBIDDEN with the moderator message', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    await expect(
      getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });

  it('INVARIANT GUARD (green at base too): NO moderation events → FORBIDDEN (fails CLOSED)', async () => {
    wireListing(listingRow());
    wireLastModerationEvent(null);

    await expect(
      getMyListingForEdit({ listingId: LISTING_ID, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: MOD_TAKEDOWN_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// getMyListingForApp → editBlockedReason — the MEDIA-EDITOR verdict
// ---------------------------------------------------------------------------

describe('getMyListingForApp editBlockedReason on a `removed` listing', () => {
  it('🔴 OWNER-UNPUBLISH ⇒ the media editor is NOT blocked (verdict is null)', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.status).toBe('removed');
    expect(res.editBlockedReason).toBeNull();
  });

  it('🔴 MESSAGE: an owner-unpublished listing never attributes the takedown to a moderator', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('owner-unpublish');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason ?? '').not.toContain('by a moderator');
    expect(res.editBlockedReason).not.toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('INVARIANT GUARD (green at base too): a MODERATOR delist still returns the moderator verdict', async () => {
    wireListing(listingRow());
    wireLastModerationEvent('delist');

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason).toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('INVARIANT GUARD (green at base too): NO moderation events → the moderator verdict (fails CLOSED)', async () => {
    wireListing(listingRow());
    wireLastModerationEvent(null);

    const res = await getMyListingForApp({ slug: 'cool-app', userId: OWNER });

    expect(res.editBlockedReason).toBe(MOD_TAKEDOWN_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// listingMediaEditBlockedReason — the PURE branch table
// ---------------------------------------------------------------------------

describe('listingMediaEditBlockedReason (pure, synchronous)', () => {
  const removed = { status: 'removed', revisionOfId: null };

  it('🔴 removed + ownerUnpublished=true ⇒ null (editable)', () => {
    expect(listingMediaEditBlockedReason(removed, true)).toBeNull();
  });

  it('INVARIANT GUARD (green at base too): removed + ownerUnpublished=false ⇒ the moderator message', () => {
    expect(listingMediaEditBlockedReason(removed, false)).toBe(MOD_TAKEDOWN_MESSAGE);
  });

  it('INVARIANT GUARD: `ownerUnpublished` is consulted ONLY on `removed`', () => {
    // A shadow, a rejected listing and an unknown status keep their verdicts whatever
    // the owner-unpublish bit says — otherwise this parameter would be a way to walk
    // past three other refusals.
    for (const ownerUnpublished of [true, false]) {
      expect(
        listingMediaEditBlockedReason(
          { status: 'approved', revisionOfId: 'apl_p' },
          ownerUnpublished
        )
      ).toBe('this listing is an internal revision draft and cannot be edited directly');
      expect(
        listingMediaEditBlockedReason({ status: 'rejected', revisionOfId: null }, ownerUnpublished)
      ).toBe('this listing was rejected; submit a new listing instead of editing it');
      expect(
        listingMediaEditBlockedReason({ status: 'banana', revisionOfId: null }, ownerUnpublished)
      ).toBe('cannot edit a listing in status banana');
      expect(
        listingMediaEditBlockedReason({ status: 'approved', revisionOfId: null }, ownerUnpublished)
      ).toBeNull();
    }
  });
});
