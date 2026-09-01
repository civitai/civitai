import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  BETA_PATCH_FIELDS,
  OffsiteRequestError,
  approveExternalRequest,
  beginListingRevision,
  listMySubmissions,
  rejectExternalRequest,
  splitBetaPatch,
  submitListingRevision,
  updateListing,
  withdrawExternalRequest,
} from '~/server/services/blocks/offsite-listing.service';
import {
  LISTING_STATUS_CHANGING_MODERATION_ACTIONS,
  STATE_NEUTRAL_MODERATION_ACTIONS,
} from '~/server/services/blocks/app-listing-owner-unpublish';
import { BETA_MESSAGE_MAX } from '~/server/schema/blocks/offsite-listing.schema';
import { BETA_UNAVAILABLE_MESSAGE } from '~/server/services/blocks/app-listing-beta.service';
import type { UpdateListingPatch } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13) — EDIT-without-withdraw (shadow-draft revision) tests.
 *
 * Covers the state machine (updateListing: draft/pending in-place; approved-trivial
 * in-place; approved-material → shadow; rejected → MUST_RESUBMIT; removed →
 * FORBIDDEN; non-owner → NOT_OWNED; invalid URL), the shadow lifecycle
 * (beginListingRevision clone + idempotent reuse; submitListingRevision request w/
 * PARENT slug + concurrent-guard + asset gate), the REVISION-AWARE approve (copy
 * shadow → parent, preserve parent id/slug, delete shadow, re-point + approve the
 * request) and the reject/withdraw revision paths (delete shadow only; parent
 * untouched), plus listMySubmissions shadow exclusion + the hasPendingRevision flag.
 *
 * All DB deps are mocked — no real Prisma. `dbRead` (replica) and `dbWrite`
 * (primary, owns `$transaction`) are DISTINCT mocks; the interactive tx runs the
 * callback with `mockWrite` itself as `tx`.
 */

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

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
    // 🔴 SEATS ARE LISTING-KEYED, so EVERY non-owner path now consults this table —
    // there is no longer an "this listing has no AppBlock" short-circuit to skip it.
    // Default: no seat, i.e. exactly the owner-only behaviour these cases assert.
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 0),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    appListingPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      count: vi.fn(async (..._a: unknown[]) => 0),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    // Backing-Image levels for the approve-time content-rating derive.
    image: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    // W13 owner controls: the batched last-moderation-event lookup (removed listings).
    appListingModerationEvent: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    // Fix B4: listMySubmissions' last-event batch is now a raw `DISTINCT ON` query.
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
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const OWNER = 42;
const OTHER = 99;
const MOD = 7;

/** Build a findUnique impl that routes by `where.id` against a row map. */
function findUniqueById(rows: Record<string, Row | null>) {
  return async (args: { where: { id: string } }) => rows[args.where.id] ?? null;
}

function resetAll() {
  for (const client of [mockRead, mockWrite]) {
    client.appListing.findUnique.mockReset().mockResolvedValue(null);
    client.appListing.findFirst.mockReset().mockResolvedValue(null);
    client.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    client.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    client.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
    client.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    client.appListingModerationEvent.findFirst.mockReset().mockResolvedValue(null);
    client.appListingModerationEvent.create
      .mockReset()
      .mockImplementation(async (a: { data: unknown }) => a.data);
    client.$queryRaw.mockReset().mockResolvedValue([]);
    client.appListingScreenshot.count.mockReset().mockResolvedValue(0);
    client.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
    client.appListingScreenshot.createMany.mockReset().mockResolvedValue({ count: 0 });
    client.appListingScreenshot.updateMany.mockReset().mockResolvedValue({ count: 0 });
    client.appListingScreenshot.deleteMany.mockReset().mockResolvedValue({ count: 0 });
    client.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
    client.appListingPublishRequest.findFirst.mockReset().mockResolvedValue(null);
    client.appListingPublishRequest.count.mockReset().mockResolvedValue(0);
    client.appListingPublishRequest.create
      .mockReset()
      .mockImplementation(async (a: { data: unknown }) => a.data);
    client.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
    client.appListingPublishRequest.findMany.mockReset().mockResolvedValue([]);
    // Default: the go-live scan-clean gate + the listMySubmissions scan dimension both
    // read image.findMany for `{ id, ingestion }` — echo every queried id as `Scanned`
    // so a normal approve passes and my-submissions shows no scan problems. (The rating
    // derive selects `{ nsfwLevel }`; tests needing a specific level override this.)
    client.image.findMany
      .mockReset()
      .mockImplementation(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
      );
    client.appListingModerationEvent.findMany.mockReset().mockResolvedValue([]);
  }
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  seq.n = 0;
}

beforeEach(resetAll);

/** A fully-populated approved parent listing row (as the editableListingSelect returns). */
function approvedParent(overrides: Partial<Row> = {}): Row {
  return {
    id: 'apl_parent',
    kind: 'offsite',
    slug: 'cool-app',
    status: 'approved',
    userId: OWNER,
    revisionOfId: null,
    name: 'Cool App',
    tagline: 'the tagline',
    description: 'the description',
    category: 'utility',
    contentRating: 'g',
    externalUrl: 'https://cool.example.com/app',
    connectClientId: null,
    iconId: 1,
    coverId: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// updateListing
// ---------------------------------------------------------------------------

describe('updateListing', () => {
  it('draft → edits IN PLACE (no shadow, no re-review)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'draft' }));
    const patch: UpdateListingPatch = { name: 'Renamed', tagline: 'new tagline' };
    const res = await updateListing({ listingId: 'apl_parent', patch, userId: OWNER });

    expect(res).toEqual({
      listingId: 'apl_parent',
      status: 'draft',
      requiresReview: false,
      shadowId: null,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { name: 'Renamed', tagline: 'new tagline' },
    });
    // No shadow was opened.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('pending → edits IN PLACE (the existing pending request keeps reviewing the row)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'pending' }));
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { description: 'updated' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(res.shadowId).toBeNull();
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { description: 'updated' },
    });
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('approved + TRIVIAL-only edit → applied IN PLACE on the live row (no re-review)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    const res = await updateListing({
      listingId: 'apl_parent',
      // tagline/description/category are trivial; contentRating is MATERIAL (see
      // its own test below) so it is deliberately NOT in this trivial patch.
      patch: { tagline: 'fresh tagline', category: 'games', description: 'new desc' },
      userId: OWNER,
    });
    expect(res).toEqual({
      listingId: 'apl_parent',
      status: 'approved',
      requiresReview: false,
      shadowId: null,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { tagline: 'fresh tagline', category: 'games', description: 'new desc' },
    });
    // No shadow — a trivial edit does not stage a revision.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('approved + contentRating change → treated as MATERIAL → shadow path (maturity re-review)', async () => {
    // Regression guard for the maturity-gate bypass: an approved author lowering
    // contentRating ('x'→'g') must NOT apply in place (the public SFW filter would
    // then show a still-mature listing to SFW users). It routes through a shadow.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ contentRating: 'x' }));
    mockRead.appListing.findFirst.mockResolvedValue(null); // no existing shadow
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { contentRating: 'g' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).toBe('apl_new_1');
    // The contentRating change landed on the SHADOW, never the live parent.
    const updateCalls = mockWrite.appListing.update.mock.calls.map((c) => c[0]);
    expect(updateCalls).toContainEqual({
      where: { id: 'apl_new_1' },
      data: { contentRating: 'g' },
    });
    expect(
      updateCalls.every((c) => (c as { where: { id: string } }).where.id !== 'apl_parent')
    ).toBe(true);
  });

  it('DRAFT + contentRating change → edits IN PLACE (no shadow — pre-approval, no gate to bypass)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      approvedParent({ status: 'draft', contentRating: 'x' })
    );
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { contentRating: 'g' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(res.shadowId).toBeNull();
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { contentRating: 'g' },
    });
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('approved + a MATERIAL name change → staged on a shadow (requiresReview), live row untouched', async () => {
    // loadOwnedEditableListing (dbRead) + beginListingRevision's owner load (dbRead)
    // both read the parent; the idempotent shadow lookup (dbRead.findFirst) → none.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null); // no existing shadow
    // beginListingRevision: in-tx race check → null (no race), then the post-tx
    // winning-shadow re-read → the row we minted.
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { name: 'Brand New Name', tagline: 'also this' },
      userId: OWNER,
    });

    expect(res.requiresReview).toBe(true);
    expect(res.listingId).toBe('apl_parent');
    expect(res.shadowId).toBe('apl_new_1');
    // The shadow was created as a draft revision of the parent.
    const shadowData = mockWrite.appListing.create.mock.calls[0][0].data as Row;
    expect(shadowData).toMatchObject({
      status: 'draft',
      revisionOfId: 'apl_parent',
      appBlockId: null,
    });
    // The FULL patch was written to the SHADOW, never the live parent.
    const updateCalls = mockWrite.appListing.update.mock.calls.map((c) => c[0]);
    expect(updateCalls).toContainEqual({
      where: { id: 'apl_new_1' },
      data: { name: 'Brand New Name', tagline: 'also this' },
    });
    expect(
      updateCalls.every((c) => (c as { where: { id: string } }).where.id !== 'apl_parent')
    ).toBe(true);
  });

  it('approved + externalUrl change → treated as MATERIAL → shadow path', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { externalUrl: 'https://cool.example.com/new-path' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).toBe('apl_new_1');
  });

  it('approved + a material field set to the SAME value → NOT material → in place (no shadow)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    const res = await updateListing({
      listingId: 'apl_parent',
      // name identical to the live value; only the tagline actually changes.
      patch: { name: 'Cool App', tagline: 'tweaked' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(res.shadowId).toBeNull();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('rejected → MUST_RESUBMIT (no row usually exists; steer to resubmit)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'rejected' }));
    await expect(
      updateListing({ listingId: 'apl_parent', patch: { name: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'MUST_RESUBMIT' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('removed → FORBIDDEN (mod-only takedown)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'removed' }));
    await expect(
      updateListing({ listingId: 'apl_parent', patch: { name: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('non-owner → NOT_OWNED (no write)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    await expect(
      updateListing({ listingId: 'apl_parent', patch: { name: 'x' }, userId: OTHER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('missing listing → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);
    await expect(
      updateListing({ listingId: 'nope', patch: { name: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('editing a SHADOW directly → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      approvedParent({ id: 'apl_shadow', status: 'draft', revisionOfId: 'apl_parent' })
    );
    await expect(
      updateListing({ listingId: 'apl_shadow', patch: { name: 'x' }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('invalid externalUrl → BAD_REQUEST (no write)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'draft' }));
    await expect(
      updateListing({
        listingId: 'apl_parent',
        patch: { externalUrl: 'http://insecure.example.com' },
        userId: OWNER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// beginListingRevision
// ---------------------------------------------------------------------------

describe('beginListingRevision', () => {
  it('clones scalars + screenshots into a hidden draft shadow (synthetic slug, null appBlockId, revisionOfId set)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null); // no existing shadow
    mockWrite.appListing.findFirst.mockResolvedValue(null); // no in-tx race
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([
      { imageId: 10, order: 0, caption: 'a' },
      { imageId: 11, order: 1, caption: null },
    ]);
    // After the tx, the winning-shadow re-read returns the row we just minted.
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null) // in-tx race check
      .mockResolvedValueOnce({ id: 'apl_new_1' }); // post-tx winner

    const res = await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    expect(res.created).toBe(true);
    expect(res.shadowId).toBe('apl_new_1');

    const shadow = mockWrite.appListing.create.mock.calls[0][0].data as Row;
    expect(shadow).toMatchObject({
      status: 'draft',
      revisionOfId: 'apl_parent',
      appBlockId: null,
      name: 'Cool App',
      externalUrl: 'https://cool.example.com/app',
      iconId: 1,
      coverId: 2,
      userId: OWNER,
    });
    // Synthetic, non-public slug — NOT the parent's public slug.
    expect(shadow.slug).toMatch(/^rev-/);
    expect(shadow.slug).not.toBe('cool-app');

    // Screenshots were copied (imageId/order/caption preserved) onto the shadow.
    const shots = mockWrite.appListingScreenshot.createMany.mock.calls[0][0].data as Row[];
    expect(shots).toHaveLength(2);
    expect(shots[0]).toMatchObject({
      appListingId: 'apl_new_1',
      imageId: 10,
      order: 0,
      caption: 'a',
    });
    expect(shots[1]).toMatchObject({
      appListingId: 'apl_new_1',
      imageId: 11,
      order: 1,
      caption: null,
    });
  });

  it('idempotent: an existing shadow is returned as-is (no second clone)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue({ id: 'apl_existing_shadow' });
    const res = await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    expect(res).toEqual({ shadowId: 'apl_existing_shadow', created: false });
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('P2002 on insert (a concurrent creator won the partial-UNIQUE) → idempotent reuse of the winning shadow', async () => {
    // Two creators race past the pre-tx + in-tx read-checks (neither sees the
    // other's uncommitted row); the loser's INSERT hits the partial-UNIQUE index
    // on revision_of_id → P2002. It must collapse to the winner, not throw.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null); // pre-tx idempotent check → none
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null) // in-tx race check → none
      .mockResolvedValueOnce({ id: 'apl_winner_shadow' }); // post-tx winner re-read
    mockWrite.appListing.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );

    const res = await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    // Reused the concurrent winner (created: false — we did not mint it).
    expect(res).toEqual({ shadowId: 'apl_winner_shadow', created: false });
  });

  it('a NON-P2002 insert error is re-thrown (not swallowed as idempotent reuse)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst.mockResolvedValueOnce(null); // in-tx race check
    mockWrite.appListing.create.mockRejectedValueOnce(
      Object.assign(new Error('deadlock detected'), { code: 'P2034' })
    );
    await expect(beginListingRevision({ listingId: 'apl_parent', userId: OWNER })).rejects.toThrow(
      'deadlock detected'
    );
  });

  it('non-approved parent → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'pending' }));
    await expect(
      beginListingRevision({ listingId: 'apl_parent', userId: OWNER })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('non-owner → NOT_OWNED', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    await expect(
      beginListingRevision({ listingId: 'apl_parent', userId: OTHER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });
});

// ---------------------------------------------------------------------------
// submitListingRevision
// ---------------------------------------------------------------------------

function shadowRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'apl_shadow',
    kind: 'offsite',
    status: 'draft',
    userId: OWNER,
    revisionOfId: 'apl_parent',
    externalUrl: 'https://cool.example.com/app',
    iconId: 1,
    coverId: 2,
    revisionOf: { slug: 'cool-app', status: 'approved' },
    ...overrides,
  };
}

describe('submitListingRevision', () => {
  it('asset-complete shadow → creates a pending request pointing at the shadow with the PARENT slug', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow());
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null); // no open request

    const res = await submitListingRevision({
      shadowId: 'apl_shadow',
      userId: OWNER,
      changelog: 'fixed the URL typo',
    });
    expect(res.shadowId).toBe('apl_shadow');
    expect(res.slug).toBe('cool-app');

    const reqData = mockWrite.appListingPublishRequest.create.mock.calls[0][0].data as Row;
    expect(reqData).toMatchObject({
      appListingId: 'apl_shadow',
      status: 'pending',
      slug: 'cool-app', // the PUBLIC parent slug, not the synthetic rev-* slug
      submittedByUserId: OWNER,
      changelog: 'fixed the URL typo',
      kind: 'offsite',
    });
  });

  it('blocks a SECOND concurrent pending revision (returns the existing open request)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow());
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue({
      id: 'alpr_open',
      slug: 'cool-app',
    });
    const res = await submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER });
    expect(res.publishRequestId).toBe('alpr_open');
    // No new request created — the existing pending one stands.
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('FLIPPED (partial-media): a shadow with icon+cover but NO screenshot now SUBMITS (screenshots optional)', async () => {
    // Was blocked by the full-completeness gate; the floor gate (icon+cover) lets a
    // screenshot-less revision submit. The shadow carries iconId+coverId.
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow());
    mockWrite.appListingScreenshot.count.mockResolvedValue(0); // no real screenshot
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
    const res = await submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER });
    expect(res).toMatchObject({ shadowId: 'apl_shadow', slug: 'cool-app' });
    expect(mockWrite.appListingPublishRequest.create).toHaveBeenCalled();
  });

  it('BELOW FLOOR: a shadow missing its cover → BAD_REQUEST, no request', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow({ coverId: null }));
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cover') });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('a non-shadow listing (revisionOfId null) → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      shadowRow({ revisionOfId: null, revisionOf: null })
    );
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('a non-draft shadow → INVALID_REVISION', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow({ status: 'approved' }));
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
  });

  it('non-owner → NOT_OWNED', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow({ userId: OTHER }));
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
  });

  it('F1: a NO-URL (connect-only) shadow (externalUrl null) submits successfully — the URL gate is optional', async () => {
    // Merged model: a no-homepage external app carries externalUrl: null. Gating the
    // URL unconditionally made such a listing UN-REVISABLE (validateExternalUrl(null)
    // returns {ok:false} → threw). The gate now runs only when a URL is present.
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow({ externalUrl: null }));
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);

    const res = await submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER });
    expect(res.shadowId).toBe('apl_shadow');
    expect(res.slug).toBe('cool-app');
    // A pending request WAS created (the null-URL revision was NOT blocked).
    expect(mockWrite.appListingPublishRequest.create).toHaveBeenCalledTimes(1);
  });

  it('F1: a shadow with a PRESENT-but-invalid stored URL still → BAD_REQUEST, no request', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      shadowRow({ externalUrl: 'http://insecure.example.com' })
    );
    mockWrite.appListingScreenshot.count.mockResolvedValue(1);
    mockRead.appListingPublishRequest.findFirst.mockResolvedValue(null);
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('externalUrl'),
    });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// approveExternalRequest — REVISION APPLY
// ---------------------------------------------------------------------------

describe('approveExternalRequest (revision apply)', () => {
  /** Stage a pending revision request → shadow (revisionOfId set) → live parent. */
  function stageRevisionApprove(shadow: Partial<Row> = {}) {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_rev',
      status: 'pending',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_shadow',
    });
    // Step-2 listing load (dbRead) — the SHADOW, with revisionOfId set.
    const shadowListing = {
      id: 'apl_shadow',
      status: 'draft',
      externalUrl: 'https://cool.example.com/edited',
      iconId: 5,
      coverId: 6,
      revisionOfId: 'apl_parent',
    };
    // Parent load (dbRead) inside applyApprovedRevision — must still be approved.
    mockRead.appListing.findUnique.mockImplementation(
      findUniqueById({
        apl_shadow: shadowListing as Row,
        // 🔴 `kind` IS LOAD-BEARING HERE, not decoration. It is NOT NULL in the
        // DB, so a row without it cannot exist — and omitting it made the
        // actionable-CTA gate a silent no-op: the gate skips a non-offsite
        // listing, so these tests passed with the guard DELETED. It was also
        // internally inconsistent, since `applyApprovedRevision` took the
        // off-site copy branch while the off-site gate skipped.
        apl_parent: {
          id: 'apl_parent',
          slug: 'cool-app',
          status: 'approved',
          kind: 'offsite',
        } as Row,
      })
    );
    // In-tx authoritative shadow re-read (dbWrite) — full scalars to copy.
    mockWrite.appListing.findUnique.mockImplementation(
      findUniqueById({
        apl_shadow: {
          id: 'apl_shadow',
          status: 'draft',
          revisionOfId: 'apl_parent',
          name: 'Edited Name',
          tagline: 'edited tagline',
          description: 'edited desc',
          category: 'games',
          contentRating: 'pg',
          externalUrl: 'https://cool.example.com/edited',
          connectClientId: null,
          iconId: 5,
          coverId: 6,
          ...shadow,
        } as Row,
      })
    );
    mockWrite.appListingScreenshot.count.mockResolvedValue(2);
    // Backing-Image levels for the approve-time content-rating derive: an R asset →
    // the revision path stamps the DERIVED rating ('r'), not the shadow's declared value.
    // Rows carry `id` + `ingestion: 'Scanned'` (for the scan-clean gate) alongside
    // `nsfwLevel` (for the derive) — both reads go through this same image.findMany.
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: 10 }]);
    mockWrite.image.findMany.mockResolvedValue([
      { id: 5, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 6, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 10, nsfwLevel: 4, ingestion: 'Scanned' },
    ]);
  }

  it('copies shadow scalars onto the PARENT (id/slug preserved), deletes the shadow, approves + re-points the request', async () => {
    stageRevisionApprove();
    const res = await approveExternalRequest({
      publishRequestId: 'alpr_rev',
      reviewerUserId: MOD,
      approvalNotes: 'nice edit',
    });
    // Returns the LIVE parent id + slug (not the shadow).
    expect(res).toEqual({
      publishRequestId: 'alpr_rev',
      listingId: 'apl_parent',
      slug: 'cool-app',
    });

    // The request flip re-points appListingId at the PARENT + marks approved.
    const reqCall = mockWrite.appListingPublishRequest.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(reqCall.where).toEqual({ id: 'alpr_rev', status: 'pending' });
    expect(reqCall.data).toMatchObject({
      status: 'approved',
      reviewedByUserId: MOD,
      approvalNotes: 'nice edit',
      appListingId: 'apl_parent',
    });

    // Scalars copied onto the PARENT (never the shadow), status/slug/id untouched.
    const parentUpdate = mockWrite.appListing.update.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(parentUpdate.where).toEqual({ id: 'apl_parent' });
    expect(parentUpdate.data).toEqual({
      name: 'Edited Name',
      tagline: 'edited tagline',
      description: 'edited desc',
      category: 'games',
      // DERIVED from the shadow's assets (max R) rather than copied from the shadow's
      // declared 'pg' — the never-under-rate safety applies on the revision path too.
      contentRating: 'r',
      externalUrl: 'https://cool.example.com/edited',
      // 🔴 THE SOURCE-REPO LINK IS PART OF THE APPLY SET. It is copied onto the parent
      // UNCONDITIONALLY (both directions), which is why `beginListingRevision` carries
      // it onto the shadow and why `OFFSITE_UNCOMPARED_APPLY_FIELDS` names it. This
      // fixture's shadow has none, so `null` — the CLEARING direction, i.e. the one
      // that would silently drop a live link if the copy were ever made conditional.
      sourceRepoUrl: null,
      connectClientId: null,
      // Pre-existing in the fake's payload (the mock's shadow row has no scope
      // columns); asserted here only because this is an exact-shape `toEqual`.
      connectRequestedScopes: undefined,
      connectScopeJustifications: undefined,
      iconId: 5,
      coverId: 6,
    });
    expect(parentUpdate.data).not.toHaveProperty('status');
    expect(parentUpdate.data).not.toHaveProperty('slug');

    // Screenshots reparented BEFORE the shadow delete (cascade-safe): delete parent's
    // rows, move the shadow's rows onto the parent.
    expect(mockWrite.appListingScreenshot.deleteMany).toHaveBeenCalledWith({
      where: { appListingId: 'apl_parent' },
    });
    expect(mockWrite.appListingScreenshot.updateMany).toHaveBeenCalledWith({
      where: { appListingId: 'apl_shadow' },
      data: { appListingId: 'apl_parent' },
    });
    // The shadow is retired (guarded to a revision row).
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_shadow', revisionOfId: { not: null } },
    });
  });

  it('FLIPPED (partial-media): revision approve with icon+cover but 0 screenshots now PUBLISHES (screenshots optional)', async () => {
    // Was blocked by the full-completeness gate; the floor gate (icon+cover) applies
    // a screenshot-less revision onto the live parent. The shadow has iconId+coverId.
    stageRevisionApprove();
    mockWrite.appListingScreenshot.count.mockResolvedValue(0); // no real screenshot on the shadow
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).resolves.toMatchObject({ listingId: 'apl_parent' });
    // The parent WAS copied (the apply proceeded).
    expect(mockWrite.appListing.update).toHaveBeenCalled();
  });

  it('BELOW FLOOR: revision approve with a shadow missing its icon → BAD_REQUEST, no mutation (primary re-assert)', async () => {
    stageRevisionApprove({ iconId: null });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('icon') });
    // Neither the request nor the parent were mutated.
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('revision approve TOCTOU: the request flip matches 0 rows → NOT_PENDING, parent NOT copied', async () => {
    stageRevisionApprove();
    mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('parent no longer approved (mod REMOVED it after submit) → INVALID_REVISION, nothing copied', async () => {
    // Guards the confusing "approved request → still-hidden listing" state: applying
    // the shadow's scalars onto a removed parent would not flip its status back to
    // approved. Refuse before touching the request/parent.
    stageRevisionApprove();
    mockRead.appListing.findUnique.mockImplementation(
      findUniqueById({
        apl_shadow: {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: 'https://cool.example.com/edited',
          iconId: 5,
          coverId: 6,
          revisionOfId: 'apl_parent',
        } as Row,
        apl_parent: { id: 'apl_parent', slug: 'cool-app', status: 'removed' } as Row,
      })
    );
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    // No re-point, no scalar copy, no shadow delete — the whole apply is refused
    // before the transaction.
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reject / withdraw — REVISION path (delete shadow only; parent untouched)
// ---------------------------------------------------------------------------

describe('reject/withdraw a pending REVISION', () => {
  it('rejectExternalRequest deletes ONLY the shadow (status-guarded draft); the parent is a separate row, untouched', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_rev',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_shadow', // the shadow, a draft
    });
    // Pre-tx notification snapshot: the shadow reads as a REVISION (revisionOfId set)
    // → the "not approved" owner notice is skipped (parent stays live).
    mockRead.appListing.findUnique.mockResolvedValue({
      userId: OWNER,
      name: 'Cool App',
      slug: 'cool-app',
      revisionOfId: 'apl_parent',
    });
    // In-tx `closeTerminalListing` reads the listing on the WRITE client (the tx) to
    // pick the delete-vs-flip branch — a draft shadow → the status-guarded delete.
    mockWrite.appListing.findUnique.mockResolvedValue({ status: 'draft', slug: 'apl_shadow' });
    await rejectExternalRequest({
      publishRequestId: 'alpr_rev',
      reviewerUserId: MOD,
      rejectionReason: 'the edit is not acceptable',
    });
    // The status-guarded delete targets ONLY a draft row → the shadow. The live
    // approved parent (apl_parent) is never referenced, so it stays live.
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_shadow', status: 'draft' },
    });
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'apl_parent' }) })
    );
  });

  it('withdrawExternalRequest on a revision deletes ONLY the shadow (draft); the parent is untouched', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_rev',
      status: 'pending',
      submittedByUserId: OWNER,
      appListingId: 'apl_shadow',
    });
    // In-tx `closeTerminalListing` reads the listing on the WRITE client (the tx) to
    // pick the delete-vs-flip branch — a draft shadow → the status-guarded delete.
    mockWrite.appListing.findUnique.mockResolvedValue({ status: 'draft', slug: 'apl_shadow' });
    await withdrawExternalRequest({ publishRequestId: 'alpr_rev', userId: OWNER });
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_shadow', status: 'draft' },
    });
  });
});

// ---------------------------------------------------------------------------
// listMySubmissions — shadow exclusion + hasPendingRevision flag
// ---------------------------------------------------------------------------

describe('listMySubmissions (shadow handling)', () => {
  /** The parent's own (non-shadow) request row as the main query returns it. */
  const parentRequestRow = {
    id: 'alpr_parent',
    appListingId: 'apl_parent',
    slug: 'cool-app',
    status: 'approved',
    appListing: { name: 'Cool App', revisionOfId: null, _count: { screenshots: 3 } },
  };

  it('excludes shadow-targeting requests from the main query and flags a parent with a PENDING revision request', async () => {
    // findMany is called TWICE: (1) the main rows query, (2) the pending-revision
    // detection. Chain the two responses.
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([parentRequestRow])
      // (2) a PENDING request targets a shadow of apl_parent → hasPendingRevision.
      .mockResolvedValueOnce([{ appListing: { revisionOfId: 'apl_parent' } }]);

    const res = await listMySubmissions({ userId: OWNER });

    const where = mockRead.appListingPublishRequest.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    // Widened to include onsite media revisions (kind IN onsite|offsite).
    expect(where).toMatchObject({
      submittedByUserId: OWNER,
      kind: { in: ['onsite', 'offsite'] },
    });
    // OFFSITE shadow-targeting requests are STILL excluded (surfaced as a parent
    // badge): OR keeps `appListingId null` OR `parent listing`. ONSITE requests (which
    // are always shadow revisions, and whose auto-created parent has no own request)
    // are included directly via the `{ kind: 'onsite' }` branch.
    expect(where.OR).toEqual([
      { appListingId: null },
      { appListing: { revisionOfId: null } },
      { kind: 'onsite' },
    ]);

    // The detection query filters on a PENDING request targeting a shadow — NOT on
    // shadow existence (an abandoned shadow has no such request). Widened to both kinds.
    const revWhere = mockRead.appListingPublishRequest.findMany.mock.calls[1][0].where as Record<
      string,
      unknown
    >;
    expect(revWhere).toMatchObject({
      status: 'pending',
      kind: { in: ['onsite', 'offsite'] },
      appListing: { revisionOfId: { in: ['apl_parent'] } },
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ id: 'alpr_parent', hasPendingRevision: true });
  });

  it('a parent with NO pending revision request → hasPendingRevision false', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([parentRequestRow])
      .mockResolvedValueOnce([]); // no pending revision requests
    const res = await listMySubmissions({ userId: OWNER });
    expect(res.items[0]).toMatchObject({ hasPendingRevision: false });
  });

  it('an ABANDONED shadow (opened but never submitted → no pending request) does NOT badge the parent', async () => {
    // Regression guard for the 🟢 fix: hasPendingRevision is derived from a PENDING
    // publish request, not from shadow existence. A shadow that was created but
    // never submitted produces no pending request → the detection query returns [].
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([parentRequestRow])
      .mockResolvedValueOnce([]); // shadow exists in the DB, but no PENDING request targets it
    const res = await listMySubmissions({ userId: OWNER });
    expect(res.items[0]).toMatchObject({ hasPendingRevision: false });
  });
});

// ---------------------------------------------------------------------------
// listMySubmissions — lastModerationAction projection (W13 owner controls)
// ---------------------------------------------------------------------------

describe('listMySubmissions (lastModerationAction for removed listings)', () => {
  /** A REMOVED listing's request row (the request stays `approved` after a takedown). */
  const removedRequestRow = {
    id: 'alpr_removed',
    appListingId: 'apl_removed',
    slug: 'gone-app',
    status: 'approved',
    appListing: {
      name: 'Gone App',
      revisionOfId: null,
      status: 'removed',
      _count: { screenshots: 3 },
    },
  };
  const liveRequestRow = {
    id: 'alpr_live',
    appListingId: 'apl_live',
    slug: 'live-app',
    status: 'approved',
    appListing: {
      name: 'Live App',
      revisionOfId: null,
      status: 'approved',
      _count: { screenshots: 3 },
    },
  };

  it('attaches the latest moderation-event action for a REMOVED listing (owner-unpublish → eligible)', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([removedRequestRow])
      .mockResolvedValueOnce([]); // no pending revision
    // Fix B4: the last-event batch is a raw `DISTINCT ON` query — one row per listing.
    mockRead.$queryRaw.mockResolvedValueOnce([
      { appListingId: 'apl_removed', action: 'owner-unpublish' },
    ]);

    const res = await listMySubmissions({ userId: OWNER });

    // The raw last-event query is issued exactly once for the removed listing set.
    expect(mockRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(res.items[0]).toMatchObject({ lastModerationAction: 'owner-unpublish' });
  });

  it('surfaces a moderator takedown (delist) as the lastModerationAction (republish forbidden client-side)', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([removedRequestRow])
      .mockResolvedValueOnce([]);
    mockRead.$queryRaw.mockResolvedValueOnce([{ appListingId: 'apl_removed', action: 'delist' }]);
    const res = await listMySubmissions({ userId: OWNER });
    expect(res.items[0]).toMatchObject({ lastModerationAction: 'delist' });
  });

  it('does NOT query moderation events for a LIVE listing (no removed rows) → null action', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([liveRequestRow])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    expect(mockRead.$queryRaw).not.toHaveBeenCalled();
    expect(res.items[0]).toMatchObject({ lastModerationAction: null });
  });

  // -------------------------------------------------------------------------
  // 🔴 THE RAW STATEMENT IS PINNED AS TEXT, IN FULL.
  //
  // This is the PRIMARY surface for owner republish, and it is the one last-action read
  // written in SQL, so it is the one place a second hand-maintained spelling of the
  // status-changing set would live and never be noticed. It was UNFILTERED: a
  // `message-owner` / `claim` / `report-resolve` newer than the owner's own
  // `owner-unpublish` became "the last action", the page badged the listing "removed by a
  // moderator" and hid Republish on a listing `republishOwnListing` would have allowed.
  //
  // Every other test in this describe mocks `$queryRaw`'s RESULT, so no behavioural
  // assertion can see the statement at all — deleting the new `AND action IN (…)` changes
  // nothing any of them observe.
  //
  // 🔴 AND IT IS PINNED AS THE WHOLE NORMALISED STRING, not a regex feature of it. A
  // partial pattern ("contains `action IN`") is satisfied by semantically INVERTED SQL
  // (`action NOT IN`), by a predicate `OR`-ed instead of `AND`-ed, and by a token sitting
  // inside a `--` comment — "the token is present" and "the clause is live" are different
  // facts. A cosmetic reword of this SQL will fail this test; that is the price of a
  // machine-readable claim, and it is worth paying here.
  // -------------------------------------------------------------------------
  describe('the DISTINCT ON statement (pinned as whole text)', () => {
    /** Collapse all runs of whitespace so indentation changes don't churn the pin. */
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

    async function rawCall() {
      mockRead.appListingPublishRequest.findMany
        .mockResolvedValueOnce([removedRequestRow])
        .mockResolvedValueOnce([]);
      mockRead.$queryRaw.mockResolvedValueOnce([
        { appListingId: 'apl_removed', action: 'owner-unpublish' },
      ]);
      await listMySubmissions({ userId: OWNER });
      expect(mockRead.$queryRaw).toHaveBeenCalledTimes(1);
      // `Prisma.sql` builds a `Sql` object: `.strings` is the static text, `.values` the
      // bound parameters. `$queryRaw(Prisma.sql`…`)` passes that object as calls[0][0].
      const arg = mockRead.$queryRaw.mock.calls[0][0] as {
        strings: string[];
        values: unknown[];
      };
      return { sql: norm(arg.strings.join('?')), values: arg.values };
    }

    it('POSITIVE CONTROL: the pin is reading real SQL, not an empty string', async () => {
      const { sql } = await rawCall();
      // Without this, a `toBe('')`-shaped accident would read as a pass.
      expect(sql.length).toBeGreaterThan(80);
      expect(sql).toMatch(/\bSELECT DISTINCT ON\b/);
    });

    it('🔴 is EXACTLY this statement — filter, table, ordering and all', async () => {
      const { sql } = await rawCall();
      expect(sql).toBe(
        norm(`
          SELECT DISTINCT ON (app_listing_id)
            app_listing_id AS "appListingId",
            action
          FROM app_listing_moderation_events
          WHERE app_listing_id IN (?)
            AND action IN (?,?,?,?,?,?)
          ORDER BY app_listing_id, created_at DESC, id DESC
        `)
      );
    });

    it('🔴 the action list is BOUND from the shared constant, in order — not typed out', async () => {
      const { sql, values } = await rawCall();
      // One removed listing id, then the six status-changing actions, as parameters.
      expect(values).toEqual(['apl_removed', ...LISTING_STATUS_CHANGING_MODERATION_ACTIONS]);
      // A verb appearing in the STATIC half would mean a string-built second spelling.
      for (const a of LISTING_STATUS_CHANGING_MODERATION_ACTIONS) expect(sql).not.toContain(a);
    });

    it.each([...STATE_NEUTRAL_MODERATION_ACTIONS])(
      '🔴 %s is not bound — it cannot displace the event that explains the removal',
      async (neutral) => {
        const { values } = await rawCall();
        expect(values).not.toContain(neutral);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// listMySubmissions — the KIND seam of the completeness advisory
// ---------------------------------------------------------------------------

/**
 * 🔴 `listMySubmissions` IS NOT AN OFF-SITE-ONLY READ, despite living in
 * `offsite-listing.service`. Its `where` carries an explicit `{ kind: 'onsite' }`
 * OR-branch (pinned by the shadow-handling describe above) so ON-SITE MEDIA REVISIONS
 * appear on /apps/my-submissions — an on-site listing is auto-created and has no own
 * publish request, so its only representation IS the revision request. That makes this
 * the one caller of `computeListingProblems` where BOTH kinds genuinely arrive on the
 * same page, and where a hardcoded `'offsite'` would be wrong in production rather than
 * merely fragile.
 *
 * The three empty-text problems now name a different remedy per kind: an on-site
 * listing's name/tagline/description/category have NO author surface other than
 * `block.manifest.json`, and `approveRequest`'s (3b-sync) re-sync overwrites them from
 * the manifest on every subsequent-version approve.
 *
 * 🔴 EVERY CASE IS PAIRED and the OFF-SITE arm is the POSITIVE CONTROL — an on-site-only
 * assertion would pass equally against an implementation that gave BOTH kinds the
 * manifest label, which is the same defect pointing the other way.
 *
 * 🔴 WHICH CASES ARE REGRESSION COVERAGE. Measured at `origin/main` 4bfd4c16d: 4 of the
 * 10 cases below go RED — the on-site media revision, "BOTH KINDS ON ONE PAGE diverge",
 * the listing-kind projection, and "request.kind and listing.kind DISAGREE". The other 6
 * PASS at base and are INVARIANT GUARDS (the fixture guard, the off-site positive
 * control, code invariance, the degrade path, and the disagreement MIRROR). They pin
 * what must NOT move; they are not evidence the defect was fixed.
 */
describe('listMySubmissions (the advisory is KIND-AWARE)', () => {
  const MANIFEST_TAGLINE = 'Missing tagline — set "tagline" in block.manifest.json and resubmit';
  const ORIGINAL_TAGLINE = 'Missing tagline';

  /**
   * A request row whose backing listing has every asset but NO tagline, so exactly ONE
   * problem fires and a whole-list assertion can be exact. Asset ids are pairwise
   * distinct (icon 41, cover 53) and distinct from the screenshot count (7), so an
   * operand swap changes the ANSWER rather than the argument. `kind` has NO default —
   * every call states it, so a fixture cannot quietly inherit one arm.
   */
  const requestRow = (
    id: string,
    listingId: string,
    kind: string,
    /**
     * The REQUEST's kind, which defaults to matching the listing's.
     *
     * 🔴 IT IS A SEPARATE PARAMETER SO THE TWO CAN BE MADE TO DISAGREE. They are
     * different columns on different tables and they agree at every request-create
     * site today — which is exactly why a fixture that always sets them equal cannot
     * tell `r.appListing.kind` from `r.kind`. An audit mutant that read the REQUEST's
     * kind SURVIVED all 132 tests for that reason. The stated rationale for reading
     * the listing's is that they MIGHT diverge, so one fixture has to make them.
     */
    requestKind: string = kind
  ) => ({
    id,
    appListingId: listingId,
    slug: `app-${id}`,
    kind: requestKind,
    status: 'approved',
    appListing: {
      name: `App ${id}`,
      revisionOfId: null,
      status: 'approved',
      kind,
      iconId: 41,
      coverId: 53,
      description: 'A description.',
      tagline: null,
      category: 'utility',
      screenshots: [],
      _count: { screenshots: 7 },
    },
  });

  const taglineLabelOf = (item: { problems: { code: string; label: string }[] }) =>
    item.problems.find((p) => p.code === 'empty-tagline')?.label;

  it('🔴 fixture guard — the two fixtures declare DIFFERENT, known LISTING kinds', () => {
    const on = requestRow('r_on', 'apl_on', 'onsite');
    const off = requestRow('r_off', 'apl_off', 'offsite');
    for (const r of [on, off]) {
      expect(Object.prototype.hasOwnProperty.call(r.appListing, 'kind')).toBe(true);
      expect(['onsite', 'offsite']).toContain(r.appListing.kind);
    }
    expect(on.appListing.kind).not.toBe(off.appListing.kind);
  });

  it('an ON-SITE media revision names block.manifest.json', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([requestRow('r_on', 'apl_on', 'onsite')])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    // Positive control: exactly the one text problem.
    expect(res.items[0].problems.map((p) => p.code)).toEqual(['empty-tagline']);
    expect(taglineLabelOf(res.items[0])).toBe(MANIFEST_TAGLINE);
  });

  it('POSITIVE CONTROL — an OFF-SITE submission still produces the ORIGINAL label, verbatim', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([requestRow('r_off', 'apl_off', 'offsite')])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    expect(res.items[0].problems.map((p) => p.code)).toEqual(['empty-tagline']);
    expect(taglineLabelOf(res.items[0])).toBe(ORIGINAL_TAGLINE);
  });

  it('🔴 BOTH KINDS ON ONE PAGE diverge — each row reads its OWN listing kind', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([
        requestRow('r_on', 'apl_on', 'onsite'),
        requestRow('r_off', 'apl_off', 'offsite'),
      ])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });

    expect(res.items.map((i) => i.id)).toEqual(['r_on', 'r_off']);
    const labels = Object.fromEntries(res.items.map((i) => [i.id, taglineLabelOf(i)]));
    expect(labels['r_on']).toBe(MANIFEST_TAGLINE);
    expect(labels['r_off']).toBe(ORIGINAL_TAGLINE);
    expect(labels['r_on']).not.toBe(labels['r_off']);
  });

  it('the CODE is identical either way (wire contract — a released CLI branches on `code`)', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([
        requestRow('r_on', 'apl_on', 'onsite'),
        requestRow('r_off', 'apl_off', 'offsite'),
      ])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    for (const item of res.items) {
      expect(
        item.problems.map((p) => p.code),
        item.id
      ).toEqual(['empty-tagline']);
    }
  });

  it("the query PROJECTS the LISTING's kind, not only the REQUEST's", async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([requestRow('r_on', 'apl_on', 'onsite')])
      .mockResolvedValueOnce([]);
    await listMySubmissions({ userId: OWNER });
    // The mock's arg is typed `unknown`; cast the ARG, not a property of it — reaching
    // through an `unknown` is a type error even in this (root-typecheck-excluded)
    // directory, and this file should not add to that backlog.
    const args = mockRead.appListingPublishRequest.findMany.mock.calls[0][0] as {
      select: { kind?: boolean; appListing: { select: Record<string, unknown> } };
    };
    const select = args.select;
    // 🔴 BOTH, and the nested one is the load-bearing half: they are different columns on
    // different tables, and the advisory is a statement about the LISTING. Reading the
    // request's kind would be a derived surface standing in for the defining one.
    expect(select.appListing.select.kind).toBe(true);
    expect(select.kind).toBe(true);
  });

  /**
   * 🔴 THE DISCRIMINATING CASE FOR LISTING-KIND-vs-REQUEST-KIND, and the ONLY one.
   *
   * Every other fixture in this describe sets `request.kind === appListing.kind`,
   * because that is what production does at all three request-create sites. The
   * consequence, found by an adversarial audit of #4370: a mutant changing the call
   * site from `r.appListing.kind` to `r.kind` SURVIVED the entire 132-test battery.
   * Not a live hole — the two genuinely agree today — but the stated rationale for
   * reading the LISTING's column is precisely that they are independent and might
   * diverge, and a rationale nothing can falsify is not a tested claim.
   *
   * This fixture makes them disagree in the direction that matters: an OFF-SITE
   * request row pointing at an ON-SITE listing. The advisory is a statement about the
   * LISTING, so the manifest label must win. Reading `r.kind` yields the original
   * label and fails here — which is what turns the comment into a guard.
   */
  it('🔴 request.kind and listing.kind DISAGREE — the LISTING wins', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([requestRow('r_split', 'apl_split', 'onsite', 'offsite')])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });

    // Positive control on the fixture itself: the two really do disagree, so this case
    // cannot quietly degrade into another copy of the aligned ones.
    const row = mockRead.appListingPublishRequest.findMany.mock.results[0].value as Promise<
      Array<{ kind: string; appListing: { kind: string } }>
    >;
    const [first] = await row;
    expect(first.kind).toBe('offsite');
    expect(first.appListing.kind).toBe('onsite');

    expect(res.items[0].problems.map((p) => p.code)).toEqual(['empty-tagline']);
    expect(taglineLabelOf(res.items[0])).toBe(MANIFEST_TAGLINE);
  });

  it('the MIRROR — an on-site request pointing at an off-site listing takes the OFF-SITE label', async () => {
    // Both directions, so the case cannot pass by the arms having been swapped.
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([requestRow('r_split2', 'apl_split2', 'offsite', 'onsite')])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    expect(taglineLabelOf(res.items[0])).toBe(ORIGINAL_TAGLINE);
  });

  it('a fake that omits the listing kind degrades to the ORIGINAL labels, and never throws', async () => {
    mockRead.appListingPublishRequest.findMany
      .mockResolvedValueOnce([
        {
          id: 'r_bare',
          appListingId: 'apl_bare',
          slug: 'bare',
          status: 'approved',
          appListing: {
            name: 'Bare',
            revisionOfId: null,
            status: 'approved',
            iconId: 41,
            coverId: 53,
            description: 'A description.',
            tagline: null,
            category: 'utility',
            _count: { screenshots: 7 },
          },
        },
      ])
      .mockResolvedValueOnce([]);
    const res = await listMySubmissions({ userId: OWNER });
    expect(taglineLabelOf(res.items[0])).toBe(ORIGINAL_TAGLINE);
  });
});

// ---------------------------------------------------------------------------
// BETA — the TRIVIAL, NEVER-STAGED listing-native flag.
//
// 🔴 THE SINGLE MOST IMPORTANT BEHAVIOURAL CLAIM IN THIS FEATURE is the first test
// below: a beta-only patch on an APPROVED listing applies IN PLACE and mints NO shadow
// revision. That is the whole product decision — "trivial, not material" — expressed as
// a state-machine assertion rather than as an absence from a constant. Asserting only
// that `isBeta` is missing from `MATERIAL_LISTING_PATCH_FIELDS` would pass while the
// routing did something else entirely.
// ---------------------------------------------------------------------------

describe('updateListing — BETA is TRIVIAL (in place, no review)', () => {
  it('🔴 approved + a beta-ONLY patch → applied IN PLACE, NO shadow revision minted', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { isBeta: true, betaMessage: 'Expect rough edges.' },
      userId: OWNER,
    });

    expect(res.requiresReview).toBe(false);
    expect(res.shadowId).toBeNull();
    expect(res.listingId).toBe('apl_parent');
    // Written straight to the LIVE row.
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { isBeta: true, betaMessage: 'Expect rough edges.' },
    });
    // 🔴 THE NEGATIVE HALF, and it is the half that fails if beta ever becomes material:
    // no shadow row was created at all.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('positive control — a NAME change on the same fixture DOES mint a shadow', async () => {
    // Without this, the assertion above would also pass on a harness where `create` can
    // never fire (a broken mock, a short-circuited branch). This proves the same fixture
    // and the same mocks CAN reach the shadow path, so the `not.toHaveBeenCalled()` above
    // is reporting a property of the PATCH, not of the harness.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { name: 'Renamed' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(mockWrite.appListing.create).toHaveBeenCalled();
  });

  it('a beta-only patch on a DRAFT listing applies in place too', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'draft' }));
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { isBeta: true },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { isBeta: true },
    });
  });

  it('an empty / whitespace-only beta message is stored as NULL, not as ""', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    await updateListing({
      listingId: 'apl_parent',
      patch: { betaMessage: '   ' },
      userId: OWNER,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { betaMessage: null },
    });
  });

  it('an over-long beta message is REFUSED as BAD_REQUEST — the bound is re-checked server-side', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    await expect(
      updateListing({
        listingId: 'apl_parent',
        patch: { betaMessage: 'x'.repeat(BETA_MESSAGE_MAX + 1) },
        userId: OWNER,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('a message of EXACTLY the cap is accepted — the boundary is inclusive', async () => {
    // The positive control for the refusal above: without it, a mutant that refuses every
    // message (`>= MAX`, or an unconditional throw) still passes that test.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    const atCap = 'x'.repeat(BETA_MESSAGE_MAX);
    await updateListing({ listingId: 'apl_parent', patch: { betaMessage: atCap }, userId: OWNER });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { betaMessage: atCap },
    });
  });

  it('a beta edit is ALLOWED on an owner-unpublished listing (it is not material)', async () => {
    // The repair state refuses only MATERIAL fields. Beta is copy, like the tagline the
    // refusal message already names — an author whose app is down can still say it is beta.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'removed' }));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValue({
      action: 'owner-unpublish',
    });
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { isBeta: true },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { isBeta: true },
    });
  });
});

describe('updateListing — a MIXED patch splits: material to the shadow, beta to the PARENT', () => {
  it('🔴 the beta half lands on the LIVE parent while the material half is staged', async () => {
    // 🔴 THE SPLIT IS THE POINT. If beta rode the shadow, `applyApprovedRevision` — which
    // copies no beta column — would never deliver it, so the author's toggle would appear
    // to do nothing until (and unless) a moderator approved an unrelated revision.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { name: 'Renamed', isBeta: true, betaMessage: 'wip' },
      userId: OWNER,
    });

    expect(res.requiresReview).toBe(true);
    const calls = mockWrite.appListing.update.mock.calls.map((c) => c[0]) as Array<{
      where: { id: string };
      data: Record<string, unknown>;
    }>;
    const toShadow = calls.filter((c) => c.where.id === 'apl_new_1');
    const toParent = calls.filter((c) => c.where.id === 'apl_parent');

    // The material half went to the shadow, and carries NEITHER beta key.
    expect(toShadow).toHaveLength(1);
    expect(toShadow[0].data).toEqual({ name: 'Renamed' });
    // The beta half went to the live parent, and carries ONLY the beta keys.
    expect(toParent).toHaveLength(1);
    expect(toParent[0].data).toEqual({ isBeta: true, betaMessage: 'wip' });
  });

  it('a material-only patch writes ONCE, to the shadow — no empty parent write', async () => {
    // Guards the `patchHasAnyField` branch: a mutant that writes unconditionally would
    // issue a pointless `update` with an empty `data` against the LIVE listing.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });
    await updateListing({ listingId: 'apl_parent', patch: { name: 'Renamed' }, userId: OWNER });
    const calls = mockWrite.appListing.update.mock.calls.map((c) => c[0]) as Array<{
      where: { id: string };
    }>;
    expect(calls.filter((c) => c.where.id === 'apl_parent')).toHaveLength(0);
  });
});

describe('beta survives the revision round trip — for BOTH kinds', () => {
  /**
   * 🔴 THE HAZARD THIS PINS. The recipe that shipped `sourceRepoUrl` was "add the new
   * scalar to `beginListingRevision`'s clone AND to `applyApprovedRevision`'s copy", because
   * the apply copies the shadow's scalars UNCONDITIONALLY — so a column the clone forgets is
   * silently CLEARED on every approve.
   *
   * Beta closes that hazard by the opposite route, and these tests pin the route rather than
   * the recipe: the apply names NEITHER beta column, in EITHER kind branch, so there is
   * nothing to revert to and the parent's value survives by construction. The clone still
   * carries them, but only so the moderator PREVIEW (which renders the shadow row) shows the
   * beta banner being approved.
   */

  /** Drive an approved offsite revision all the way through `applyApprovedRevision`. */
  async function approveRevision(kind: 'onsite' | 'offsite') {
    const parent = approvedParent({ kind });
    const shadow = {
      ...approvedParent({ kind }),
      id: 'apl_shadow',
      status: 'draft',
      revisionOfId: 'apl_parent',
      // The shadow's own (clone-time) beta snapshot, deliberately DIFFERENT from what the
      // live parent would now hold — that difference is what a copy-back would destroy.
      isBeta: true,
      betaMessage: 'stale clone-time note',
    };
    mockRead.appListing.findUnique.mockImplementation(
      findUniqueById({ apl_parent: parent, apl_shadow: shadow })
    );
    mockWrite.appListing.findUnique.mockImplementation(
      findUniqueById({ apl_parent: parent, apl_shadow: shadow })
    );
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      slug: 'cool-app',
      status: 'pending',
      kind,
      appListingId: 'apl_shadow',
      appListing: { id: 'apl_shadow', revisionOfId: 'apl_parent', status: 'draft' },
    });
    await approveExternalRequest({
      publishRequestId: 'alpr_1',
      reviewerUserId: MOD,
      approvalNotes: null,
    });
    return mockWrite.appListing.update.mock.calls
      .map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> })
      .filter((c) => c.where.id === 'apl_parent');
  }

  it.each(['offsite', 'onsite'] as const)(
    '🔴 %s: the apply writes NEITHER beta column onto the parent',
    async (kind) => {
      const parentWrites = await approveRevision(kind);
      expect(parentWrites.length).toBeGreaterThan(0);
      for (const write of parentWrites) {
        expect(Object.keys(write.data)).not.toContain('isBeta');
        expect(Object.keys(write.data)).not.toContain('betaMessage');
      }
    }
  );

  it('positive control — the OFFSITE apply DOES copy the scalars it is supposed to', async () => {
    // Without this, the assertion above would pass on an apply that copies nothing at all
    // (a broken fixture, a short-circuited branch): "no beta keys" is only meaningful once
    // the same call is shown to write the keys it should.
    const parentWrites = await approveRevision('offsite');
    const keys = parentWrites.flatMap((w) => Object.keys(w.data));
    expect(keys).toContain('name');
    expect(keys).toContain('externalUrl');
  });

  it('positive control — the ONSITE apply writes the ASSET columns and nothing else', async () => {
    const parentWrites = await approveRevision('onsite');
    const keys = parentWrites.flatMap((w) => Object.keys(w.data));
    expect(keys).toContain('iconId');
    expect(keys).toContain('coverId');
    // The onsite branch stays assets-only, which is what keeps `revisionApplyScope('onsite')`
    // honest — adding beta here would have broken the review panel's no-op claim.
    expect(keys).not.toContain('name');
  });

  it('beginListingRevision CLONES beta onto the shadow (for the moderator preview)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      approvedParent({ isBeta: true, betaMessage: 'in progress' })
    );
    mockWrite.appListing.findUnique.mockResolvedValue(
      approvedParent({ isBeta: true, betaMessage: 'in progress' })
    );
    mockRead.appListing.findFirst.mockResolvedValue(null);
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });

    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });

    const created = mockWrite.appListing.create.mock.calls[0][0].data as Row;
    expect(created).toMatchObject({ isBeta: true, betaMessage: 'in progress' });
  });

  it('the clone OMITS both keys when the manual-apply columns are unreadable', async () => {
    // 🔴 OMITTED, not defaulted. Writing `isBeta: false` against a missing column raises the
    // same P2022 and rolls back the whole clone transaction — so opening a revision (a
    // PRE-EXISTING flow) would break for an additive field.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    mockRead.appListing.findFirst.mockResolvedValue(null);
    // The primary-side guarded beta read throws the missing-column error; every other
    // primary read still resolves normally.
    mockWrite.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args?.select && 'isBeta' in args.select) {
          const err = new Error('column does not exist') as Error & { code?: string };
          err.code = 'P2022';
          throw err;
        }
        return approvedParent();
      }
    );
    mockWrite.appListing.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'apl_new_1' });

    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });

    const created = mockWrite.appListing.create.mock.calls[0][0].data as Row;
    expect('isBeta' in created).toBe(false);
    expect('betaMessage' in created).toBe(false);
    // Positive control: the clone still happened and still carried its ordinary scalars, so
    // the assertion above is about the beta keys and not about an aborted create.
    expect(created).toMatchObject({ status: 'draft', revisionOfId: 'apl_parent' });
  });
});

describe('the AUTHOR-facing refusal when the migration has not been applied', () => {
  it('🔴 refuses with PRECONDITION_FAILED and the EXACT message — never a silent drop', async () => {
    // 🔴 THE EXACT STRING, so a mutant that swaps this guard for the source-repo guard (or
    // for a BAD_REQUEST) is killed by the message rather than merely by "something threw".
    mockRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args?.select && 'isBeta' in args.select) {
          const err = new Error('column does not exist') as Error & { code?: string };
          err.code = 'P2022';
          throw err;
        }
        return approvedParent();
      }
    );

    let caught: unknown;
    try {
      await updateListing({ listingId: 'apl_parent', patch: { isBeta: true }, userId: OWNER });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((caught as TRPCError).message).toBe(BETA_UNAVAILABLE_MESSAGE);
    // Nothing was written — the guard is hoisted above every branch, so no orphan shadow
    // and no partial update is left behind.
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('a patch that does NOT touch beta is unaffected by unreadable beta columns', async () => {
    // The reachability control for the guard above: the refusal must be caused by the BETA
    // KEYS in the patch, not by the columns being unreadable. A mutant that drops the
    // `!== undefined` condition and asserts unconditionally is killed here.
    mockRead.appListing.findUnique.mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args?.select && 'isBeta' in args.select) {
          const err = new Error('column does not exist') as Error & { code?: string };
          err.code = 'P2022';
          throw err;
        }
        return approvedParent();
      }
    );
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { tagline: 'still fine' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: 'apl_parent' },
      data: { tagline: 'still fine' },
    });
  });
});

describe('splitBetaPatch — the never-staged ledger', () => {
  /**
   * 🔴 A CONSTANT THAT NOTHING ITERATES IS DECORATION. `BETA_PATCH_FIELDS` is the single
   * definition of "which keys are beta", and the split loop reads it — so these cases walk
   * the constant rather than naming the two keys again. Add a third beta column without
   * teaching the splitter about it and the first case here goes red.
   */
  it('every member of BETA_PATCH_FIELDS is moved out of the rest half', () => {
    const patch: Record<string, unknown> = { name: 'Renamed' };
    for (const field of BETA_PATCH_FIELDS) {
      patch[field] = field === 'isBeta' ? true : 'note';
    }
    const { betaPatch, restPatch } = splitBetaPatch(patch as never);
    for (const field of BETA_PATCH_FIELDS) {
      expect(betaPatch, `${field} must be in the beta half`).toHaveProperty(field);
      expect(restPatch, `${field} must NOT be in the rest half`).not.toHaveProperty(field);
    }
    // Positive control: a non-beta key survives in the rest half, so "not in rest" above is
    // not satisfied by a splitter that empties `restPatch` entirely.
    expect(restPatch).toEqual({ name: 'Renamed' });
  });

  it('an OMITTED beta key stays omitted from both halves (never defaulted)', () => {
    const { betaPatch, restPatch } = splitBetaPatch({ tagline: 'x' });
    expect(betaPatch).toEqual({});
    expect(restPatch).toEqual({ tagline: 'x' });
  });

  it('does not MUTATE the input patch', () => {
    // The caller still reads `effectivePatch` after the split (for the material comparison),
    // so a splitter that `delete`d from the original would silently change that answer.
    const patch = { name: 'Renamed', isBeta: true } as const;
    const copy = { ...patch };
    splitBetaPatch(patch);
    expect(patch).toEqual(copy);
  });

  it('carries `isBeta: false` and `betaMessage: null` — falsy values are still instructions', () => {
    // A splitter written with truthiness would drop both of these, which are precisely the
    // "turn beta off" and "clear the note" edits.
    const { betaPatch } = splitBetaPatch({ isBeta: false, betaMessage: null });
    expect(betaPatch).toEqual({ isBeta: false, betaMessage: null });
  });
});
