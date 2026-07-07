import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OffsiteModerationError,
  delistListing,
  dismissReport,
  listModerationEvents,
  purgeListing,
  relistListing,
  resolveReport,
} from '~/server/services/blocks/offsite-moderation.service';

/**
 * W13 P3b PR3 — off-site moderation ACTION service tests (delist / relist / purge
 * / resolve / dismiss + the moderation-history read). All DB deps are mocked — no
 * real Prisma. `dbWrite.$transaction` runs its callback against the SAME `dbWrite`
 * mock (the tx client), so a test asserts the exact status-guarded writes + that a
 * guarded 0-count throws BEFORE any audit event is written (zero events on a
 * guarded mutation), and that purge writes its event BEFORE the delete.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListing: { updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { create: ReturnType<typeof vi.fn> };
  appListingReport: { updateMany: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReport: { findUnique: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { findMany: ReturnType<typeof vi.fn> };
};

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListing: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    appListingModerationEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
    appListingReport: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  // The tx client is the write mock itself, so tx.* calls land on the same spies.
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReport: { findUnique: vi.fn(async () => null) },
    appListingModerationEvent: { findMany: vi.fn(async () => []) },
  };
  return { mockRead: read, mockWrite: write, ids: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
}));

const REVIEWER = 1001;
const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const REPORT_ID = 'alrp_r1';
const GOOD_REASON = 'impersonates a real vendor';

function offsiteListing(status: string, kind = 'offsite') {
  return { id: APP_ID, kind, status, slug: SLUG };
}

beforeEach(() => {
  ids.n = 0;
  vi.clearAllMocks();
  mockWrite.$transaction.mockImplementation(
    async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite)
  );
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingModerationEvent.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListingReport.updateMany.mockResolvedValue({ count: 1 });
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListingReport.findUnique.mockResolvedValue(null);
  mockRead.appListingModerationEvent.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// delistListing
// ---------------------------------------------------------------------------

describe('delistListing', () => {
  it('flips approved → removed (status+kind-guarded) and writes exactly ONE delist event', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    const res = await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });

    // The mutate is status+kind-guarded (approved-only, offsite-only).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'approved' },
      data: { status: 'removed' },
    });
    // Exactly ONE audit event, with the correct action/actor/reason/slug/before/after.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      appListingId: APP_ID,
      slug: SLUG,
      action: 'delist',
      actorUserId: REVIEWER,
      reason: GOOD_REASON,
      before: { status: 'approved' },
      after: { status: 'removed' },
      reportId: null,
    });
    // No linked report → the report table is untouched.
    expect(mockWrite.appListingReport.updateMany).not.toHaveBeenCalled();
  });

  it('a status-guarded 0-count (already removed/draft) → NOT_TRANSITIONABLE and ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_TRANSITIONABLE' });
    // Guard threw BEFORE the audit write — no event on a rolled-back mutation.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('an ON-SITE listing is rejected by the kind guard (generic NOT_FOUND, no tx)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved', 'onsite'));
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a missing listing → generic NOT_FOUND (indistinguishable from on-site)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(null);
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('with a reportId, resolves that report in the SAME tx (status-guarded)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON, reportId: REPORT_ID },
      reviewerUserId: REVIEWER,
    });
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    // The event carries the reportId link.
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.reportId).toBe(REPORT_ID);
  });

  it('a too-short reason is a BAD_REQUEST (defense-in-depth) with no DB touch', async () => {
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: 'x' }, reviewerUserId: REVIEWER })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// relistListing
// ---------------------------------------------------------------------------

describe('relistListing', () => {
  it('flips removed → approved (guarded) + one relist event with swapped before/after', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    const res = await relistListing({
      input: { appListingId: APP_ID, reason: 'appeal upheld' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: 'relist',
      before: { status: 'removed' },
      after: { status: 'approved' },
    });
  });

  it('relisting a non-removed row → NOT_TRANSITIONABLE, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// purgeListing
// ---------------------------------------------------------------------------

describe('purgeListing', () => {
  it('writes the audit event BEFORE the hard delete (so the event captures the snapshot)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    const res = await purgeListing({
      input: { appListingId: APP_ID, reason: 'confirmed impersonation' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, purged: true });

    // ORDER: event.create must be invoked before appListing.deleteMany.
    const createOrder = mockWrite.appListingModerationEvent.create.mock.invocationCallOrder[0];
    const deleteOrder = mockWrite.appListing.deleteMany.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);

    // The event snapshots the pre-delete status + slug; the delete targets the id.
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'purge',
      slug: SLUG,
      before: { status: 'removed' },
    });
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({ where: { id: APP_ID } });
  });

  it('purges regardless of the source status (approved allowed), snapshotting it', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    await purgeListing({
      input: { appListingId: APP_ID, reason: 'spam expunge' },
      reviewerUserId: REVIEWER,
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.before).toEqual({
      status: 'approved',
    });
  });

  it('the kind guard rejects an on-site listing (no tx)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed', 'onsite'));
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: 'spam expunge' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a raced delete (0-count) → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: 'spam expunge' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// resolveReport / dismissReport
// ---------------------------------------------------------------------------

describe('resolveReport / dismissReport', () => {
  const report = { id: REPORT_ID, status: 'pending', appListingId: APP_ID, appListing: { slug: SLUG } };

  it('resolveReport flips pending → resolved (guarded) + a report-resolve event with the note', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(report);
    await resolveReport({ input: { reportId: REPORT_ID, note: '  handled  ' }, reviewerUserId: REVIEWER });
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'report-resolve',
      reportId: REPORT_ID,
      slug: SLUG,
      reason: 'handled', // trimmed note
      before: { status: 'pending' },
      after: { status: 'resolved' },
    });
  });

  it('dismissReport flips pending → dismissed + a report-dismiss event; empty note → null reason', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(report);
    await dismissReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER });
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, status: 'pending' },
      data: { status: 'dismissed', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data.action).toBe('report-dismiss');
    expect(data.reason).toBeNull();
  });

  it('a non-pending report → REPORT_NOT_PENDING, ZERO events', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce({ ...report, status: 'resolved' });
    mockWrite.appListingReport.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      resolveReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'REPORT_NOT_PENDING' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('a missing report → NOT_FOUND (no tx)', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(null);
    await expect(
      dismissReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listModerationEvents
// ---------------------------------------------------------------------------

describe('listModerationEvents', () => {
  const evt = (id: string) => ({
    id,
    appListingId: APP_ID,
    slug: SLUG,
    action: 'delist',
    reason: 'r',
    detail: null,
    before: { status: 'approved' },
    after: { status: 'removed' },
    reportId: null,
    createdAt: new Date(),
    actor: { id: REVIEWER, username: 'mod', image: null },
  });

  it('is newest-first with an id tie-break, capped at 50, keyset-paginated', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([
      evt('alme_3'),
      evt('alme_2'),
      evt('alme_1'),
    ]);
    const res = await listModerationEvents({ appListingId: APP_ID, limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe('alme_2');

    const args = mockRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ appListingId: APP_ID });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(3); // 2 + 1
  });

  it('caps limit at 50 and projects a PII-safe shape (actor chip, no raw actorUserId FK)', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([]);
    await listModerationEvents({ appListingId: APP_ID, limit: 999 });
    const args = mockRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(args.take).toBe(51);
    expect(args.select.actor).toEqual({ select: { id: true, username: true, image: true } });
    expect(args.select.actorUserId).toBeUndefined();
  });

  it('nextCursor is null on the last page', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([evt('alme_1')]);
    const res = await listModerationEvents({ appListingId: APP_ID });
    expect(res.nextCursor).toBeNull();
  });
});

describe('OffsiteModerationError (PR3 codes)', () => {
  it('carries the new NOT_TRANSITIONABLE / REPORT_NOT_PENDING codes', () => {
    expect(new OffsiteModerationError('NOT_TRANSITIONABLE', 'x').code).toBe('NOT_TRANSITIONABLE');
    expect(new OffsiteModerationError('REPORT_NOT_PENDING', 'x').code).toBe('REPORT_NOT_PENDING');
  });
});
