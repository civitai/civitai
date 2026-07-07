import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteModerationError,
  REPORT_UNAVAILABLE_MESSAGE,
  listListingReports,
  reportListing,
} from '~/server/services/blocks/offsite-moderation.service';
import type { ReportListingInput } from '~/server/schema/blocks/offsite-moderation.schema';

/**
 * W13 P3b — off-site moderation SERVICE tests (report + report-queue read).
 *
 * Covers reportListing (happy path + caller-forced reporterUserId; DB-layer dedup
 * via P2002; approved-only reportable gate; reason re-validation; IDOR guard) and
 * listListingReports (keyset shape + FIFO order + public-safe projection). All DB
 * deps are mocked — no real Prisma. `dbRead`/`dbWrite` are DISTINCT mocks so a
 * test can prove the read went to the replica and the insert to the primary.
 */

type Client = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReport: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingReport: {
      create: vi.fn(async (args: { data: unknown }) => args.data),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
  });
  return { mockRead: makeClient(), mockWrite: makeClient(), ids: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
}));

const CALLER = 42;
const OTHER = 99;
const APP_ID = 'apl_target';

const validInput: ReportListingInput = { appListingId: APP_ID, reason: 'spam' };

function resetClient(c: Client) {
  c.appListing.findUnique.mockReset().mockResolvedValue(null);
  c.appListingReport.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
  c.appListingReport.findMany.mockReset().mockResolvedValue([]);
}

beforeEach(() => {
  ids.n = 0;
  resetClient(mockRead as unknown as Client);
  resetClient(mockWrite as unknown as Client);
});

describe('reportListing — happy path', () => {
  it('creates a PENDING report with reporterUserId forced from the caller', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'approved',
    });
    const res = await reportListing({ input: validInput, userId: CALLER });

    expect(res.reportId).toMatch(/^alrp_test_/);
    // The row is written to the PRIMARY (dbWrite), not the replica.
    expect((mockWrite as unknown as Client).appListingReport.create).toHaveBeenCalledTimes(1);
    expect((mockRead as unknown as Client).appListingReport.create).not.toHaveBeenCalled();
    const data = (mockWrite as unknown as Client).appListingReport.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      appListingId: APP_ID,
      reporterUserId: CALLER,
      reason: 'spam',
      status: 'pending',
      details: null,
    });
  });

  it('trims details and stores non-empty text (null when whitespace-only)', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValue({
      id: APP_ID,
      status: 'approved',
    });

    await reportListing({ input: { ...validInput, details: '  hi there  ' }, userId: CALLER });
    expect(
      (mockWrite as unknown as Client).appListingReport.create.mock.calls[0][0].data.details
    ).toBe('hi there');

    await reportListing({ input: { ...validInput, details: '   ' }, userId: CALLER });
    expect(
      (mockWrite as unknown as Client).appListingReport.create.mock.calls[1][0].data.details
    ).toBeNull();
  });

  it('IDOR: a user-supplied reporter field can never override the caller id', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'approved',
    });
    // Even if a caller smuggles a reporterUserId through, the service reads only
    // `userId` (from ctx) — the written row is bound to the caller.
    await reportListing({
      input: { ...validInput, reporterUserId: OTHER } as unknown as ReportListingInput,
      userId: CALLER,
    });
    const data = (mockWrite as unknown as Client).appListingReport.create.mock.calls[0][0].data;
    expect(data.reporterUserId).toBe(CALLER);
  });
});

describe('reportListing — reportable-state gate', () => {
  // Info-leak guard: a caller holding an arbitrary listing id must NOT be able to
  // probe existence or read the exact moderation status. Both the missing-listing
  // and the non-approved-listing cases surface the SAME client-visible code
  // (`NOT_REPORTABLE`) + `REPORT_UNAVAILABLE_MESSAGE`; the real reason/status is
  // carried only on `cause` (server-only, for logs/tests).
  it('rejects a nonexistent listing generically (NOT_REPORTABLE + generic message; NOT_FOUND only on cause)', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce(null);
    const err: OffsiteModerationError = await reportListing({
      input: validInput,
      userId: CALLER,
    }).then(
      () => {
        throw new Error('expected reportListing to reject');
      },
      (e: OffsiteModerationError) => e
    );
    expect(err.name).toBe('OffsiteModerationError');
    expect(err.code).toBe('NOT_REPORTABLE');
    // Client-visible message reveals NOTHING about existence.
    expect(err.message).toBe(REPORT_UNAVAILABLE_MESSAGE);
    // The real reason is server-only (on cause) — not in the client-facing message.
    expect(err.cause).toMatchObject({ reason: 'NOT_FOUND', appListingId: APP_ID });
    expect((mockWrite as unknown as Client).appListingReport.create).not.toHaveBeenCalled();
  });

  it.each(['draft', 'pending', 'rejected', 'removed'])(
    'rejects a %s listing generically (status is NOT client-visible — only on cause)',
    async (status) => {
      (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
        id: APP_ID,
        status,
      });
      const err: OffsiteModerationError = await reportListing({
        input: validInput,
        userId: CALLER,
      }).then(
        () => {
          throw new Error('expected reportListing to reject');
        },
        (e: OffsiteModerationError) => e
      );
      expect(err.name).toBe('OffsiteModerationError');
      expect(err.code).toBe('NOT_REPORTABLE');
      expect(err.message).toBe(REPORT_UNAVAILABLE_MESSAGE);
      // The exact status must NEVER leak into the client-facing message.
      expect(err.message).not.toContain(status);
      // …but it IS preserved server-side on cause for logs/mod tooling.
      expect(err.cause).toMatchObject({ reason: 'NOT_APPROVED', status });
      expect((mockWrite as unknown as Client).appListingReport.create).not.toHaveBeenCalled();
    }
  );

  it('missing vs non-approved are INDISTINGUISHABLE client-side (same code + same message)', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce(null);
    const missing: OffsiteModerationError = await reportListing({
      input: validInput,
      userId: CALLER,
    }).catch((e: OffsiteModerationError) => e);

    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'draft',
    });
    const notApproved: OffsiteModerationError = await reportListing({
      input: validInput,
      userId: CALLER,
    }).catch((e: OffsiteModerationError) => e);

    // A caller cannot tell "doesn't exist" from "exists but not approvable".
    expect(missing.code).toBe(notApproved.code);
    expect(missing.message).toBe(notApproved.message);
    expect(missing.message).toBe(REPORT_UNAVAILABLE_MESSAGE);
    // Only the server-side cause differs.
    expect(missing.cause).not.toEqual(notApproved.cause);
  });

  it('rejects an unknown reason (defense-in-depth) BEFORE touching the DB', async () => {
    await expect(
      reportListing({
        input: { ...validInput, reason: 'nonsense' as unknown as ReportListingInput['reason'] },
        userId: CALLER,
      })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_REPORTABLE' });
    expect((mockRead as unknown as Client).appListing.findUnique).not.toHaveBeenCalled();
  });
});

describe('reportListing — DB-layer dedup', () => {
  it('collapses the partial-unique P2002 to a friendly ALREADY_REPORTED', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'approved',
    });
    (mockWrite as unknown as Client).appListingReport.create.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    );
    await expect(reportListing({ input: validInput, userId: CALLER })).rejects.toMatchObject({
      name: 'OffsiteModerationError',
      code: 'ALREADY_REPORTED',
    });
  });

  it('re-throws a non-P2002 DB error unchanged (mapped to INTERNAL at the router)', async () => {
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'approved',
    });
    const raw = new Error('connect ECONNREFUSED');
    (mockWrite as unknown as Client).appListingReport.create.mockRejectedValueOnce(raw);
    await expect(reportListing({ input: validInput, userId: CALLER })).rejects.toBe(raw);
  });

  it('a resolved/dismissed prior report does NOT block a new one (P2002 only fires on a pending dup)', async () => {
    // The partial-unique covers WHERE status='pending', so with no live pending
    // dup the insert succeeds — modelled by create resolving normally.
    (mockRead as unknown as Client).appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      status: 'approved',
    });
    const res = await reportListing({ input: validInput, userId: CALLER });
    expect(res.reportId).toMatch(/^alrp_test_/);
  });
});

describe('listListingReports — read-only mod queue', () => {
  const row = (id: string) => ({
    id,
    appListingId: APP_ID,
    reason: 'spam',
    details: null,
    status: 'pending',
    createdAt: new Date(),
    resolvedAt: null,
    reporter: { id: CALLER, username: 'rep', image: null },
    appListing: { slug: 's', name: 'n', kind: 'offsite' },
  });

  it('returns the page + a nextCursor when there is another page (limit+1 keyset)', async () => {
    const rows = [row('alrp_1'), row('alrp_2'), row('alrp_3')];
    (mockRead as unknown as Client).appListingReport.findMany.mockResolvedValueOnce(rows);
    const res = await listListingReports({ limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe('alrp_2');
  });

  it('nextCursor is null on the last page', async () => {
    (mockRead as unknown as Client).appListingReport.findMany.mockResolvedValueOnce([row('alrp_1')]);
    const res = await listListingReports({ limit: 25 });
    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBeNull();
  });

  it('is FIFO (oldest-first) with an id tie-break for a total order, and caps limit at 50', async () => {
    (mockRead as unknown as Client).appListingReport.findMany.mockResolvedValueOnce([]);
    await listListingReports({ limit: 999 });
    const args = (mockRead as unknown as Client).appListingReport.findMany.mock.calls[0][0];
    // `createdAt` alone is non-unique (default now()) → keyset tie-break on `id`
    // so same-millisecond inserts can't skip/duplicate across a page boundary.
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(51); // 50 (cap) + 1
  });

  it('applies the status filter when given, and no filter otherwise', async () => {
    (mockRead as unknown as Client).appListingReport.findMany.mockResolvedValue([]);
    await listListingReports({ status: 'pending' });
    expect(
      (mockRead as unknown as Client).appListingReport.findMany.mock.calls[0][0].where
    ).toEqual({ status: 'pending' });

    await listListingReports({});
    expect(
      (mockRead as unknown as Client).appListingReport.findMany.mock.calls[1][0].where
    ).toEqual({});
  });

  it('projection is public-safe: no reporter email / infra fields selected', async () => {
    (mockRead as unknown as Client).appListingReport.findMany.mockResolvedValueOnce([]);
    await listListingReports({});
    const select = (mockRead as unknown as Client).appListingReport.findMany.mock.calls[0][0].select;
    // The reporter chip is the standard public {id,username,image} shape only.
    expect(select.reporter).toEqual({ select: { id: true, username: true, image: true } });
    expect(select.reporter.select.email).toBeUndefined();
    // The target listing exposes only slug/name/kind.
    expect(select.appListing).toEqual({ select: { slug: true, name: true, kind: true } });
    // No reporterUserId (raw FK) / resolvedByUserId leaked in the projection.
    expect(select.reporterUserId).toBeUndefined();
    expect(select.resolvedByUserId).toBeUndefined();
  });
});

describe('OffsiteModerationError', () => {
  it('carries the name + code the router duck-types on', () => {
    const err = new OffsiteModerationError('ALREADY_REPORTED', 'dup');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OffsiteModerationError');
    expect(err.code).toBe('ALREADY_REPORTED');
  });
});
