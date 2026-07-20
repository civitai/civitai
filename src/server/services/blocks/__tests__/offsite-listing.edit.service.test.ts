import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OffsiteRequestError,
  approveExternalRequest,
  beginListingRevision,
  listMySubmissions,
  rejectExternalRequest,
  submitListingRevision,
  updateListing,
  withdrawExternalRequest,
} from '~/server/services/blocks/offsite-listing.service';
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
    client.image.findMany.mockReset().mockResolvedValue([]);
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
    expect(updateCalls.every((c) => (c as { where: { id: string } }).where.id !== 'apl_parent')).toBe(
      true
    );
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
    expect(shadowData).toMatchObject({ status: 'draft', revisionOfId: 'apl_parent', appBlockId: null });
    // The FULL patch was written to the SHADOW, never the live parent.
    const updateCalls = mockWrite.appListing.update.mock.calls.map((c) => c[0]);
    expect(updateCalls).toContainEqual({
      where: { id: 'apl_new_1' },
      data: { name: 'Brand New Name', tagline: 'also this' },
    });
    expect(updateCalls.every((c) => (c as { where: { id: string } }).where.id !== 'apl_parent')).toBe(
      true
    );
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
    expect(shots[0]).toMatchObject({ appListingId: 'apl_new_1', imageId: 10, order: 0, caption: 'a' });
    expect(shots[1]).toMatchObject({ appListingId: 'apl_new_1', imageId: 11, order: 1, caption: null });
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
    await expect(
      beginListingRevision({ listingId: 'apl_parent', userId: OWNER })
    ).rejects.toThrow('deadlock detected');
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

  it('asset-incomplete shadow (no screenshot) → BAD_REQUEST, no request', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(shadowRow());
    mockWrite.appListingScreenshot.count.mockResolvedValue(0); // no real screenshot
    await expect(
      submitListingRevision({ shadowId: 'apl_shadow', userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('screenshots') });
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
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('externalUrl') });
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
        apl_parent: { id: 'apl_parent', slug: 'cool-app', status: 'approved' } as Row,
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
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: 10 }]);
    mockWrite.image.findMany.mockResolvedValue([{ nsfwLevel: 4 }]);
  }

  it('copies shadow scalars onto the PARENT (id/slug preserved), deletes the shadow, approves + re-points the request', async () => {
    stageRevisionApprove();
    const res = await approveExternalRequest({
      publishRequestId: 'alpr_rev',
      reviewerUserId: MOD,
      approvalNotes: 'nice edit',
    });
    // Returns the LIVE parent id + slug (not the shadow).
    expect(res).toEqual({ publishRequestId: 'alpr_rev', listingId: 'apl_parent', slug: 'cool-app' });

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
      connectClientId: null,
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

  it('revision approve is BLOCKED if the shadow is asset-incomplete (primary re-assert)', async () => {
    stageRevisionApprove();
    mockWrite.appListingScreenshot.count.mockResolvedValue(0); // no real screenshot on the shadow
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('screenshots') });
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
    appListing: { name: 'Cool App', revisionOfId: null },
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
    expect(where).toMatchObject({ submittedByUserId: OWNER, kind: 'offsite' });
    // Shadow-targeting requests are excluded (OR: appListingId null OR parent listing).
    expect(where.OR).toEqual([{ appListingId: null }, { appListing: { revisionOfId: null } }]);

    // The detection query filters on a PENDING request targeting a shadow — NOT on
    // shadow existence (an abandoned shadow has no such request).
    const revWhere = mockRead.appListingPublishRequest.findMany.mock.calls[1][0].where as Record<
      string,
      unknown
    >;
    expect(revWhere).toMatchObject({
      status: 'pending',
      kind: 'offsite',
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
    appListing: { name: 'Gone App', revisionOfId: null, status: 'removed' },
  };
  const liveRequestRow = {
    id: 'alpr_live',
    appListingId: 'apl_live',
    slug: 'live-app',
    status: 'approved',
    appListing: { name: 'Live App', revisionOfId: null, status: 'approved' },
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
});
