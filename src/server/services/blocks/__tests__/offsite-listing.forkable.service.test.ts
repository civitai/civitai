import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { Prisma } from '@prisma/client';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';

import {
  updateListing,
  updateRevisionDraft,
} from '~/server/services/blocks/offsite-listing.service';
import {
  FORKABLE_OFFSITE_MESSAGE,
  FORKABLE_ON_REVISION_MESSAGE,
  FORKABLE_UNAVAILABLE_MESSAGE,
} from '~/server/services/blocks/app-fork.service';

/**
 * The author's fork opt-in through `updateListing` — "Let others fork this app's source".
 *
 * The contract, case by case:
 *   - the OWNER and an ACCEPTED COLLABORATOR can set it; anyone else is refused (NOT_OWNED, which
 *     the router maps to FORBIDDEN — the router test pins that half);
 *   - it is NOT a material change: an APPROVED listing gets it in place, with no shadow revision
 *     and no publish request, i.e. no moderator review;
 *   - it is written to the LIVE listing only — even when the same patch's material half is staged
 *     on a shadow;
 *   - it is refused on an OFF-SITE listing (no source to fork), on the revision-draft path (which
 *     cannot write it and would otherwise drop it silently), and while the migration is absent;
 *   - an edit that is refused for any reason never changes it.
 *
 * All DB deps are mocked. The opt-in itself is raw SQL (the column is stripped from the Prisma
 * client), so the write is observed as the `$executeRaw` statement and its bound values; the SQL
 * itself is executed for real in `app-fork.service.behavior.test.ts`.
 */

const { seq } = vi.hoisted(() => ({ seq: { n: 0 } }));

/**
 * The CANONICAL `~/server/db/client` mock (registered globally in src/__tests__/setup.ts), never a
 * per-file `vi.mock` — see `no-direct-shared-module-mock.test.ts`. Unconfigured methods answer the
 * conservative defaults (`findMany` → [], `$executeRaw` → 0, `$transaction` runs its callback on
 * `dbWrite`); everything these cases depend on is set explicitly in `beforeEach`.
 */
const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

// Pairwise-distinct ids (no user id equals another, no listing id equals a block id).
const OWNER = 4101;
const COLLABORATOR = 4102;
const STRANGER = 4103;
const LISTING = 'apl_onsite_5001';
const BLOCK = 'ab_onsite_5002';

/** An ON-SITE listing row as the edit paths read it. Ownership is the block's OauthClient owner. */
function onsiteListing(over: Record<string, unknown> = {}) {
  return {
    id: LISTING,
    kind: 'onsite',
    slug: 'forkable-app',
    status: 'approved',
    userId: OWNER,
    revisionOfId: null,
    revisionOf: null,
    name: 'Forkable App',
    tagline: 'old tagline',
    description: 'the description',
    category: 'utility',
    contentRating: 'g',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 11,
    coverId: 12,
    appBlockId: BLOCK,
    appBlock: { app: { userId: OWNER } },
    ...over,
  };
}

/** The statement text of a raw call: tagged-template form, or a single `Prisma.Sql`. */
function sqlText(args: unknown[]): string {
  const first = args[0];
  if (Array.isArray(first)) return (first as readonly string[]).join('?');
  return (first as Prisma.Sql | undefined)?.text ?? '';
}

/** The bound values of every `app_listings.forkable` write, in order. */
function forkableWrites(): unknown[][] {
  return mockWrite.$executeRaw.mock.calls
    .filter((c: unknown[]) => sqlText(c).includes('"forkable"'))
    .map((c: unknown[]) => c.slice(1));
}

/** Make the opt-in column read as present (`available`) or absent (42703 via Prisma raw). */
function forkableColumn(present: boolean) {
  mockRead.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    if (sqlText(args).includes('"forkable"')) {
      if (!present)
        throw Object.assign(new Error('column does not exist'), {
          code: 'P2010',
          meta: { code: '42703' },
        });
      return [{ forkable: false }];
    }
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  for (const c of [mockRead, mockWrite]) {
    c.appListing.findUnique.mockReset().mockResolvedValue(onsiteListing());
    c.appListing.findFirst.mockReset().mockResolvedValue(null);
    c.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appListing.update.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
    c.appCollaborator.findFirst.mockReset().mockResolvedValue(null);
    c.$executeRaw.mockReset().mockResolvedValue(1);
    c.$queryRaw.mockReset().mockResolvedValue([]);
  }
  forkableColumn(true);
});

describe('updateListing — the fork opt-in', () => {
  it('the OWNER turns it on for an APPROVED listing in place: no shadow, no review', async () => {
    const res = await updateListing({
      listingId: LISTING,
      patch: { forkable: true },
      userId: OWNER,
    });

    expect(res).toEqual({
      listingId: LISTING,
      status: 'approved',
      requiresReview: false,
      shadowId: null,
    });
    expect(forkableWrites()).toEqual([[true, LISTING]]);
    // Not material: no shadow revision was minted and nothing entered a review queue.
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('an ACCEPTED COLLABORATOR can set it too', async () => {
    mockRead.appCollaborator.findFirst.mockResolvedValue({ userId: COLLABORATOR });
    const res = await updateListing({
      listingId: LISTING,
      patch: { forkable: false },
      userId: COLLABORATOR,
    });
    expect(res.requiresReview).toBe(false);
    expect(forkableWrites()).toEqual([[false, LISTING]]);
  });

  it('a STRANGER is refused, and nothing is written', async () => {
    await expect(
      updateListing({ listingId: LISTING, patch: { forkable: true }, userId: STRANGER })
    ).rejects.toMatchObject({ name: 'OffsiteRequestError', code: 'NOT_OWNED' });
    expect(forkableWrites()).toEqual([]);
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('an OFF-SITE listing is refused — it has no source here to fork', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(
      onsiteListing({
        kind: 'offsite',
        appBlockId: null,
        appBlock: null,
        externalUrl: 'https://x.example.com',
      })
    );
    await expect(
      updateListing({ listingId: LISTING, patch: { forkable: true }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: FORKABLE_OFFSITE_MESSAGE });
    expect(forkableWrites()).toEqual([]);
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });

  it('while the migration is absent it is REFUSED up front, never attempted', async () => {
    forkableColumn(false);
    await expect(
      updateListing({
        listingId: LISTING,
        patch: { forkable: true, tagline: 'new tagline' },
        userId: OWNER,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: FORKABLE_UNAVAILABLE_MESSAGE });
    // Hoisted: the tagline half was not applied either.
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
    expect(forkableWrites()).toEqual([]);
  });

  it('rides along with a trivial edit: the tagline in place, the opt-in on the same live row', async () => {
    await updateListing({
      listingId: LISTING,
      patch: { tagline: 'new tagline', forkable: true },
      userId: OWNER,
    });
    expect(mockWrite.appListing.update).toHaveBeenCalledWith({
      where: { id: LISTING },
      data: { tagline: 'new tagline' },
    });
    expect(forkableWrites()).toEqual([[true, LISTING]]);
  });

  it('with a MATERIAL change in the same patch it still goes to the LIVE listing, never the shadow', async () => {
    const res = await updateListing({
      listingId: LISTING,
      patch: { name: 'Renamed App', forkable: true },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).not.toBeNull();
    expect(res.shadowId).not.toBe(LISTING);
    expect(forkableWrites()).toEqual([[true, LISTING]]);
  });

  it('a DRAFT listing takes it in place too', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(onsiteListing({ status: 'draft' }));
    const res = await updateListing({
      listingId: LISTING,
      patch: { forkable: true },
      userId: OWNER,
    });
    expect(res).toEqual({
      listingId: LISTING,
      status: 'draft',
      requiresReview: false,
      shadowId: null,
    });
    expect(forkableWrites()).toEqual([[true, LISTING]]);
  });

  it('a REFUSED edit never changes it', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(onsiteListing({ status: 'rejected' }));
    await expect(
      updateListing({ listingId: LISTING, patch: { forkable: true }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'MUST_RESUBMIT' });
    expect(forkableWrites()).toEqual([]);
  });
});

describe('updateRevisionDraft — the opt-in is never staged', () => {
  it('refuses it rather than dropping it silently, and writes nothing', async () => {
    const SHADOW = 'apl_shadow_5003';
    mockRead.appListing.findUnique.mockResolvedValue(
      onsiteListing({
        id: SHADOW,
        status: 'draft',
        revisionOfId: LISTING,
        appBlockId: null,
        appBlock: null,
        revisionOf: onsiteListing(),
      })
    );
    await expect(
      updateRevisionDraft({ shadowId: SHADOW, patch: { forkable: true }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: FORKABLE_ON_REVISION_MESSAGE });
    expect(forkableWrites()).toEqual([]);
    expect(mockWrite.appListing.update).not.toHaveBeenCalled();
  });
});
