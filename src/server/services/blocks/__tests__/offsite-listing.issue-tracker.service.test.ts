import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCError } from '@trpc/server';

/**
 * Off-site `issueTrackerUrl` — the author write paths, the MATERIAL classification and the
 * shadow-revision round trip, against the no-type, manual-apply `issue_tracker_url` column.
 *
 *   1. MATERIAL. On an approved listing a changed link is STAGED on the shadow revision; the
 *      live parent is not written, so it cannot go live before a moderator approves.
 *   2. THE ROUND TRIP. `beginListingRevision` carries the parent's link onto the shadow (or an
 *      approve that never touched it would CLEAR it), and only `applyApprovedRevision`
 *      publishes the shadow's value onto the parent — in both directions.
 *   3. THE MISSING COLUMN. Before the migration runs: an author who types a link is refused
 *      with PRECONDITION_FAILED and nothing is written; an author who does not is unaffected;
 *      the revision apply issues no statement naming the column inside its transaction.
 *
 * The column is reached by raw SQL only, so these tests arm `$queryRaw` and read `$executeRaw`.
 */

type Row = Record<string, unknown> & { id: string };

const { seq } = vi.hoisted(() => ({ seq: { n: 0 } }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

const mockRead = dbMock.dbRead;
const mockWrite = dbMock.dbWrite;

vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_new_${++seq.n}`,
  newAppListingPublishRequestId: () => `alpr_new_${++seq.n}`,
  newAppListingScreenshotId: () => `apls_new_${++seq.n}`,
  newUlid: () => `ULID${++seq.n}`,
}));

const { approveExternalRequest, beginListingRevision, submitExternalListing, updateListing } =
  await import('~/server/services/blocks/offsite-listing.service');

const OWNER = 42;
const MOD = 7;
const LIVE_TRACKER = 'https://live-tracker-6620.example.test/issues';
const NEW_TRACKER = 'https://new-tracker-6621.example.test/support';
/** The refusal, as a literal: an expectation imported from the module would move with it. */
const REFUSAL =
  'The issue tracker link is not available on this environment yet. Leave the field empty and try again later.';

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
    sourceRepoUrl: null,
    connectClientId: null,
    connectRequestedScopes: null,
    connectScopeJustifications: null,
    iconId: 1,
    coverId: 2,
    ...overrides,
  };
}

/** The SQL text of a `$queryRaw` / `$executeRaw` call (Prisma.sql object or tagged template). */
function sqlText(q: unknown): string {
  if (Array.isArray(q)) return (q as string[]).join('?');
  const o = q as { sql?: string; strings?: readonly string[] };
  return String(o?.sql ?? o?.strings?.join('?') ?? '');
}

const missingColumn = () =>
  Object.assign(new Error('column "issue_tracker_url" does not exist'), { code: '42703' });

/** A transient fault — NOT a missing column, so it must never read as "no column". */
const connectionLost = () =>
  Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1001' });

/**
 * Arm a client's raw reads of the column: `values` maps listing id → stored link; an id not in
 * it reads as no row. `missing` makes every statement naming the column raise 42703.
 */
function armTracker(
  client: typeof mockRead,
  values: Record<string, string | null>,
  opts: { missing?: boolean; transient?: boolean } = {}
) {
  // Tagged-template calls: `(strings, ...values)`, the listing id being the first value.
  client.$queryRaw.mockImplementation(async (q: unknown, ...vals: unknown[]) => {
    if (!sqlText(q).includes('issue_tracker_url')) return [];
    if (opts.missing) throw missingColumn();
    if (opts.transient) throw connectionLost();
    const id = vals[0] as string;
    return id in values ? [{ issueTrackerUrl: values[id] }] : [];
  });
}

/** Every raw WRITE of the column, as `{ id, value }`. */
function trackerWrites(): Array<{ id: unknown; value: unknown }> {
  return mockWrite.$executeRaw.mock.calls
    .filter((c: unknown[]) => sqlText(c[0]).includes('issue_tracker_url'))
    .map((c: unknown[]) => ({ value: c[1], id: c[2] }));
}

/** Every raw statement on the write client naming the column. */
function trackerQueriesOnWrite(): number {
  return mockWrite.$queryRaw.mock.calls.filter((c: unknown[]) =>
    sqlText(c[0]).includes('issue_tracker_url')
  ).length;
}

function armShadowOpen() {
  mockRead.appListing.findFirst.mockResolvedValue(null);
  mockWrite.appListing.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 'apl_new_1' });
}

beforeEach(() => {
  vi.clearAllMocks();
  seq.n = 0;
  mockWrite.appListing.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListing.update.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingScreenshot.createMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingScreenshot.updateMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingScreenshot.deleteMany.mockResolvedValue({ count: 0 });
  mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.$executeRaw.mockResolvedValue(1);
  mockWrite.image.findMany.mockImplementation(
    async (args: { where?: { id?: { in?: number[] } } }) =>
      (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
  );
});

describe('🔴 an issue-tracker change on an APPROVED listing is staged on the shadow', () => {
  it('a DIFFERENT link → requiresReview, written to the SHADOW, never to the live parent', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armTracker(mockRead, { apl_parent: LIVE_TRACKER });
    armTracker(mockWrite, { apl_parent: LIVE_TRACKER });
    armShadowOpen();

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { issueTrackerUrl: NEW_TRACKER },
      userId: OWNER,
    });

    expect(res.requiresReview).toBe(true);
    expect(res.shadowId).toBe('apl_new_1');
    const writes = trackerWrites();
    // The clone carried the LIVE value onto the shadow, then the edit overwrote it there.
    expect(writes).toEqual([
      { id: 'apl_new_1', value: LIVE_TRACKER },
      { id: 'apl_new_1', value: NEW_TRACKER },
    ]);
    expect(writes.some((w) => w.id === 'apl_parent')).toBe(false);
  });

  it('a CLEAR of a live link is material too, and is staged (null on the shadow)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armTracker(mockRead, { apl_parent: LIVE_TRACKER });
    armTracker(mockWrite, { apl_parent: LIVE_TRACKER });
    armShadowOpen();

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { issueTrackerUrl: null },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(true);
    expect(trackerWrites().at(-1)).toEqual({ id: 'apl_new_1', value: null });
    expect(trackerWrites().some((w) => w.id === 'apl_parent')).toBe(false);
  });

  it('the SAME link in another spelling is NOT material (canonical comparison)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armTracker(mockRead, { apl_parent: LIVE_TRACKER });
    armTracker(mockWrite, { apl_parent: LIVE_TRACKER });

    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { issueTrackerUrl: `  ${LIVE_TRACKER.replace('live-tracker', 'LIVE-TRACKER')} ` },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });
});

describe('the revision round trip carries the issue-tracker link', () => {
  it('🔴 beginListingRevision COPIES the parent’s link onto the shadow (read on the PRIMARY)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    // The replica says nothing; only the primary answers. A clone that read the replica
    // would mint a shadow without the link, and approving it would clear the live one.
    armTracker(mockRead, {});
    armTracker(mockWrite, { apl_parent: LIVE_TRACKER });
    armShadowOpen();

    await beginListingRevision({ listingId: 'apl_parent', userId: OWNER });
    expect(trackerWrites()).toEqual([{ id: 'apl_new_1', value: LIVE_TRACKER }]);
  });

  /** Arm an approve of the revision `apl_shadow` of `apl_parent`. */
  function armApprove() {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_rev',
      status: 'pending',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_shadow',
    });
    mockRead.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === 'apl_parent')
        return { id: 'apl_parent', slug: 'cool-app', status: 'approved', kind: 'offsite' };
      if (args.where.id === 'apl_shadow')
        return {
          id: 'apl_shadow',
          status: 'draft',
          externalUrl: 'https://cool.example.com/app',
          iconId: 5,
          coverId: 6,
          revisionOfId: 'apl_parent',
        };
      return null;
    });
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: 10 }]);
    mockWrite.image.findMany.mockResolvedValue([
      { id: 5, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 6, nsfwLevel: 1, ingestion: 'Scanned' },
      { id: 10, nsfwLevel: 1, ingestion: 'Scanned' },
    ]);
    mockWrite.appListing.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === 'apl_shadow'
        ? {
            id: 'apl_shadow',
            status: 'draft',
            revisionOfId: 'apl_parent',
            name: 'Cool App',
            tagline: 't',
            description: 'd',
            category: 'utility',
            contentRating: 'g',
            externalUrl: 'https://cool.example.com/app',
            connectClientId: null,
            connectRequestedScopes: null,
            connectScopeJustifications: null,
            connectClient: null,
            iconId: 5,
            coverId: 6,
          }
        : null
    );
  }

  it('applyApprovedRevision PUBLISHES the shadow’s link onto the live parent', async () => {
    armApprove();
    armTracker(mockWrite, { apl_shadow: NEW_TRACKER, apl_parent: LIVE_TRACKER });

    await approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });
    expect(trackerWrites()).toEqual([{ id: 'apl_parent', value: NEW_TRACKER }]);
  });

  it('a revision that CLEARED the link clears it on the parent (both directions)', async () => {
    armApprove();
    armTracker(mockWrite, { apl_shadow: null, apl_parent: LIVE_TRACKER });

    await approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });
    expect(trackerWrites()).toEqual([{ id: 'apl_parent', value: null }]);
  });

  it('🔴 with the column MISSING: one pre-transaction probe, and nothing naming it inside', async () => {
    armApprove();
    armTracker(mockWrite, {}, { missing: true });

    await approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD });
    // The approve still completed (the parent got its scalar copy)…
    expect(
      mockWrite.appListing.update.mock.calls.some(
        (c: unknown[]) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
      )
    ).toBe(true);
    // …and the only statement that named the column was the probe, before the transaction.
    expect(trackerQueriesOnWrite()).toBe(1);
    expect(trackerWrites()).toEqual([]);
  });

  it('🔴 a TRANSIENT probe error fails the approve — the reviewed link is not silently dropped', async () => {
    // Read as "no column", the apply would copy every other scalar and skip the link, so a
    // moderator-approved Support change would vanish with a success response.
    armApprove();
    armTracker(mockWrite, {}, { transient: true });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_rev', reviewerUserId: MOD })
    ).rejects.toThrow();
    // Nothing was applied: the live parent was not rewritten without its link.
    expect(
      mockWrite.appListing.update.mock.calls.some(
        (c: unknown[]) => (c[0] as { where: { id: string } }).where.id === 'apl_parent'
      )
    ).toBe(false);
    expect(trackerWrites()).toEqual([]);
  });

  it('🔴 a TRANSIENT probe error fails beginListingRevision — no shadow without the live link', async () => {
    // Read as "no column", the shadow would be minted WITHOUT the parent's link, and the
    // later approve (column readable again) would CLEAR the live link.
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armTracker(mockRead, { apl_parent: LIVE_TRACKER });
    armTracker(mockWrite, {}, { transient: true });
    armShadowOpen();
    await expect(beginListingRevision({ listingId: 'apl_parent', userId: OWNER })).rejects.toThrow(
      'Connection terminated'
    );
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });
});

describe('🔴 the author paths before the migration runs', () => {
  const CLIENT_ID = 'oauth-client-1';
  const submitInput = (overrides: Record<string, unknown> = {}) =>
    ({
      slug: 'brand-new-app',
      name: 'Brand New App',
      connectClientId: CLIENT_ID,
      requestedScopes: 0,
      scopeJustifications: {},
      contentRating: 'g',
      ...overrides,
    } as Parameters<typeof submitExternalListing>[0]['input']);
  function armSubmit() {
    mockRead.oauthClient.findUnique.mockResolvedValue({
      id: CLIENT_ID,
      userId: OWNER,
      allowedScopes: 0,
    });
    mockRead.appListingPublishRequest.count.mockResolvedValue(0);
    mockRead.appListing.findUnique.mockResolvedValue(null);
    mockRead.appBlock.findFirst.mockResolvedValue(null);
    mockWrite.appBlock.findFirst.mockResolvedValue(null);
    mockWrite.appListingPublishRequest.create.mockImplementation(
      async (a: { data: unknown }) => a.data
    );
  }

  it('submit WITH a link: PRECONDITION_FAILED, and nothing is created', async () => {
    armSubmit();
    armTracker(mockWrite, {}, { missing: true });
    let thrown: TRPCError | undefined;
    try {
      await submitExternalListing({
        input: submitInput({ issueTrackerUrl: NEW_TRACKER }),
        userId: OWNER,
      });
    } catch (e) {
      thrown = e as TRPCError;
    }
    expect(thrown?.code).toBe('PRECONDITION_FAILED');
    expect(thrown?.message).toBe(REFUSAL);
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
  });

  it('🔴 submit WITHOUT a link is unaffected: no probe, no write, the listing is created', async () => {
    armSubmit();
    armTracker(mockWrite, {}, { missing: true });
    const res = await submitExternalListing({ input: submitInput(), userId: OWNER });
    expect(res.slug).toBe('brand-new-app');
    expect(mockWrite.appListing.create).toHaveBeenCalledTimes(1);
    expect(trackerQueriesOnWrite()).toBe(0);
    expect(trackerWrites()).toEqual([]);
  });

  it('POSITIVE CONTROL: with the column present, submit stores the NORMALISED link', async () => {
    armSubmit();
    armTracker(mockWrite, {});
    const res = await submitExternalListing({
      input: submitInput({ issueTrackerUrl: '  https://NEW-TRACKER-6621.example.test/support ' }),
      userId: OWNER,
    });
    expect(trackerWrites()).toEqual([{ id: res.listingId, value: NEW_TRACKER }]);
    // Never through the Prisma create: the column is not on the generated model.
    const created = (
      mockWrite.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect('issueTrackerUrl' in created).toBe(false);
  });

  it('an APPROVED listing edit naming the link: PRECONDITION_FAILED and NO orphan shadow', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent());
    armTracker(mockRead, {}, { missing: true });
    armTracker(mockWrite, {}, { missing: true });
    armShadowOpen();
    await expect(
      updateListing({
        listingId: 'apl_parent',
        patch: { issueTrackerUrl: NEW_TRACKER },
        userId: OWNER,
      })
    ).rejects.toThrow(REFUSAL);
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(trackerWrites()).toEqual([]);
  });

  it('🔴 an unrelated edit on the same listing still applies, and never names the column', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(approvedParent({ status: 'draft' }));
    armTracker(mockRead, {}, { missing: true });
    armTracker(mockWrite, {}, { missing: true });
    const res = await updateListing({
      listingId: 'apl_parent',
      patch: { tagline: 'a new tagline' },
      userId: OWNER,
    });
    expect(res.requiresReview).toBe(false);
    expect(mockWrite.appListing.update).toHaveBeenCalled();
    expect(trackerWrites()).toEqual([]);
  });
});
