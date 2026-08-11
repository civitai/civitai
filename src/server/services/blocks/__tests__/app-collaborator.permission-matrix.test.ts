import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AppBlockIds from '~/server/utils/app-block-ids';

/**
 * 🔴 THE PERMISSION MATRIX — table-driven `role × entry-point × expected`, executed
 * against the REAL widened gates rather than against `resolveAppAccess` alone.
 *
 * `app-access.service.test.ts` pins the predicate. This file pins that each gate
 * actually CONSULTS it: a structural check type-checks past a wrong argument, so every
 * cell here drives the real service function and asserts allow/deny.
 *
 * Subjects: owner · accepted editor · PENDING editor · REJECTED editor · stranger ·
 * moderator. The moderator column is where the pre-existing D1 divergence shows up and
 * is asserted AS IT IS, not as it "should" be — `app-listing-assets` bypasses for mods,
 * `offsite-listing` does not.
 *
 * Also covers CONCURRENCY: two editors share ONE shadow revision per parent, via
 * `beginListingRevision`'s idempotent-reuse path.
 */

const { mockDb } = vi.hoisted(() => {
  const db = {
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      update: vi.fn(async (args: unknown) => args),
    },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      createMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
      count: vi.fn(async (..._a: unknown[]) => 0),
    },
    appListingPublishRequest: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    appCollaborator: { findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    oauthClient: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    image: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (cb: unknown) =>
    typeof cb === 'function' ? (cb as (tx: typeof db) => Promise<unknown>)(db) : Promise.all(cb as unknown[])
  );
  return { mockDb: db };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/utils/app-block-ids', async (importOriginal) => {
  const actual = await importOriginal<typeof AppBlockIds>();
  return { ...actual };
});

const APP = 'ab_app1';
const LIVE = 'apl_live';
const SHADOW = 'apl_shadow';
const OWNER = 10;
const EDITOR = 20;
const PENDING = 30;
const REJECTED = 40;
const STRANGER = 50;
const MOD = 60;

type Subject = { label: string; id: number; isModerator: boolean };
const SUBJECTS: Subject[] = [
  { label: 'owner', id: OWNER, isModerator: false },
  { label: 'accepted editor', id: EDITOR, isModerator: false },
  { label: 'PENDING editor', id: PENDING, isModerator: false },
  { label: 'REJECTED editor', id: REJECTED, isModerator: false },
  { label: 'stranger', id: STRANGER, isModerator: false },
  { label: 'moderator', id: MOD, isModerator: true },
];

const SEATS = [
  { userId: EDITOR, status: 'accepted' },
  { userId: PENDING, status: 'pending' },
  { userId: REJECTED, status: 'rejected' },
];

/** A DRAFT listing (freely editable, so the edit-lock never masks the access gate). */
function draftListing(over: Record<string, unknown> = {}) {
  return {
    id: LIVE,
    kind: 'onsite',
    slug: 'my-app',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: 'g',
    externalUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    userId: OWNER,
    iconId: null,
    coverId: null,
    status: 'draft',
    revisionOfId: null,
    appBlockId: APP,
    revisionOf: null,
    // `loadListingEditView` selects these relations off the SAME row; without them its
    // `screenshots.map` throws and every ALLOW cell would fail for a reason that has
    // nothing to do with access.
    icon: null,
    cover: null,
    screenshots: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (cb: unknown) =>
    typeof cb === 'function'
      ? (cb as (tx: typeof mockDb) => Promise<unknown>)(mockDb)
      : Promise.all(cb as unknown[])
  );
  mockDb.appBlock.findUnique.mockResolvedValue({ id: APP, blockId: 'my-app', app: { userId: OWNER } });
  mockDb.appListing.findUnique.mockResolvedValue(draftListing());
  mockDb.appListing.findFirst.mockResolvedValue(null);
  mockDb.appCollaborator.findFirst.mockImplementation(async (args: unknown) => {
    const w = (args as { where: { userId: number; status?: string } }).where;
    const hit = SEATS.find((r) => r.userId === w.userId && (w.status === undefined || r.status === w.status));
    return hit ? { userId: hit.userId } : null;
  });
});

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

/**
 * `true` = the subject may reach the entry point.
 *
 * 🔴 The `moderator` column differs BY ENTRY POINT, and that is a faithful record of a
 * PRE-EXISTING divergence (ledger D1), not a new inconsistency introduced here:
 * `app-listing-assets::loadOwnedListing` has always bypassed for moderators, while
 * `offsite-listing::loadOwnedEditableListing` has always refused them ("no mod override
 * on the author edit path").
 */
const MATRIX: Record<string, Record<string, boolean>> = {
  // app-listing-assets: getListingAssets (mod bypass)
  'assets.getListingAssets': {
    owner: true,
    'accepted editor': true,
    'PENDING editor': false,
    'REJECTED editor': false,
    stranger: false,
    moderator: true,
  },
  // offsite-listing: getMyListingForEdit (NO mod bypass)
  'offsite.getMyListingForEdit': {
    owner: true,
    'accepted editor': true,
    'PENDING editor': false,
    'REJECTED editor': false,
    stranger: false,
    moderator: false,
  },
  // offsite-listing: getMyListingForApp (NO mod bypass)
  'offsite.getMyListingForApp': {
    owner: true,
    'accepted editor': true,
    'PENDING editor': false,
    'REJECTED editor': false,
    stranger: false,
    moderator: false,
  },
};

const { getListingAssets } = await import('~/server/services/blocks/app-listing-assets.service');
const { getMyListingForApp, getMyListingForEdit, beginListingRevision } = await import(
  '~/server/services/blocks/offsite-listing.service'
);

const RUNNERS: Record<string, (s: Subject) => Promise<unknown>> = {
  'assets.getListingAssets': (s) =>
    getListingAssets(
      { listingId: LIVE },
      { id: s.id, isModerator: s.isModerator } as never
    ),
  'offsite.getMyListingForEdit': (s) => getMyListingForEdit({ listingId: LIVE, userId: s.id }),
  'offsite.getMyListingForApp': (s) => getMyListingForApp({ appBlockId: APP, userId: s.id }),
};

describe('permission matrix — role × entry point', () => {
  for (const [entry, row] of Object.entries(MATRIX)) {
    for (const subject of SUBJECTS) {
      const allowed = row[subject.label];
      it(`${entry} · ${subject.label} → ${allowed ? 'ALLOW' : 'DENY'}`, async () => {
        const call = RUNNERS[entry](subject);
        if (allowed) await expect(call).resolves.toBeTruthy();
        else await expect(call).rejects.toBeTruthy();
      });
    }
  }

  it('POSITIVE CONTROL: the matrix has both ALLOW and DENY cells per entry point', () => {
    // An all-true (or all-false) row would make its whole column vacuous.
    for (const [entry, row] of Object.entries(MATRIX)) {
      const values = Object.values(row);
      expect(values, `${entry} must have at least one ALLOW`).toContain(true);
      expect(values, `${entry} must have at least one DENY`).toContain(false);
    }
  });

  it('every subject appears in every row (no silently-unmeasured cell)', () => {
    for (const [entry, row] of Object.entries(MATRIX)) {
      expect(Object.keys(row).sort(), `${entry}`).toEqual(SUBJECTS.map((s) => s.label).sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrency: two editors, ONE shadow.
// ---------------------------------------------------------------------------

describe('🔴 SHARED SHADOW — two editors converge on one revision draft', () => {
  const APPROVED = () => draftListing({ status: 'approved' });

  beforeEach(() => {
    mockDb.appListing.findUnique.mockResolvedValue(APPROVED());
  });

  it('a standing shadow is REUSED, not cloned again (created: false)', async () => {
    mockDb.appListing.findFirst.mockResolvedValue({ id: SHADOW });
    const a = await beginListingRevision({ listingId: LIVE, userId: OWNER });
    const b = await beginListingRevision({ listingId: LIVE, userId: EDITOR });
    expect(a).toEqual({ shadowId: SHADOW, created: false });
    // 🔴 EDITOR B DELIBERATELY LANDS ON EDITOR A'S SHADOW. One parent has at most one
    // in-flight shadow (a partial UNIQUE on revision_of_id), so collaborators SHARE a
    // staged revision — B sees A's unsubmitted edits. That is intended: a revision is a
    // property of the LISTING, not of whoever opened it. It is documented here because
    // the alternative reading ("B lost their edits") is the natural first assumption.
    expect(b).toEqual({ shadowId: SHADOW, created: false });
    expect(mockDb.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 the P2002 race collapses to idempotent reuse rather than surfacing an error', async () => {
    // Editor B's INSERT loses to editor A's committed shadow on the partial-unique
    // index. B must receive A's shadow, not a 500.
    let probe = 0;
    mockDb.appListing.findFirst.mockImplementation(async () => {
      // 1st: the pre-tx idempotency probe (miss). 2nd: the in-tx race re-check (miss).
      // 3rd: the post-P2002 winner re-read (hit).
      probe += 1;
      return probe >= 3 ? { id: SHADOW } : null;
    });
    mockDb.appListing.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    const res = await beginListingRevision({ listingId: LIVE, userId: EDITOR });
    expect(res.shadowId).toBe(SHADOW);
    expect(res.created).toBe(false);
  });

  it('🔴 NEGATIVE CONTROL: a non-P2002 failure is NOT collapsed into reuse', async () => {
    // A broad catch would turn a genuine write failure into a silent "reused" answer.
    mockDb.appListing.findFirst.mockResolvedValue(null);
    mockDb.appListing.create.mockRejectedValue(
      Object.assign(new Error('disk on fire'), { code: 'P1001' })
    );
    await expect(beginListingRevision({ listingId: LIVE, userId: EDITOR })).rejects.toThrow(
      'disk on fire'
    );
  });

  it('a PENDING invitee cannot open a revision at all', async () => {
    mockDb.appListing.findFirst.mockResolvedValue({ id: SHADOW });
    await expect(beginListingRevision({ listingId: LIVE, userId: PENDING })).rejects.toBeTruthy();
  });
});
