import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportStatus } from '$lib/reports';

/**
 * Replaces the end-to-end coverage #4179 had to drop when #3573 deleted `report.setStatus` from the
 * main app. Every case below pins a defect that shipped once — see the service's own comments.
 */

const updateSpy = vi.fn();
const recordModActivity = vi.fn();
const rewardReportReporters = vi.fn();
const redisMarkResolved = vi.fn().mockResolvedValue(1);
const redisClearResolved = vi.fn().mockResolvedValue(1);

let existingReportId: number | undefined;
/** `undefined` means the guarded UPDATE matched nothing, i.e. the status was already set. */
let updateResult: { userId: number; alsoReportedBy: number[] | null } | undefined;
let affectedRows: number;

type Call = [string, unknown[]];

/**
 * A stand-in for the two Kysely chains this module builds.
 *
 * 🔴 It must answer from the RECORDED CHAIN, never from a variable alone, or it cannot see the query
 * shape at all. The case that forces this: without `.returning()`, real Kysely resolves an UPDATE to
 * `UpdateResult { numUpdatedRows }` — TRUTHY — so `changed: !!updated` would be permanently true, the
 * 409 path unreachable, and every re-action would reward the reporters again. A fake that resolves to
 * a fixture cannot distinguish that from correct code. Hence:
 *   - the UPDATE yields the returned row only when `returning` was called, and otherwise the truthy
 *     `UpdateResult` real Kysely would give;
 *   - both chains match on the recorded `where`, so a query scoped to the wrong row — or to no row at
 *     all — resolves to nothing rather than passing.
 */
function chain(record: (calls: Call[]) => void, resolve: (calls: Call[]) => unknown) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'set', 'where', 'returning']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.executeTakeFirst = async () => {
    record(calls);
    return resolve(calls);
  };
  return builder;
}

const wheres = (calls: Call[]) => calls.filter(([m]) => m === 'where').map(([, a]) => a);

vi.mock('../db', () => ({
  dbRead: {},
  dbWrite: {
    selectFrom: (table: string) =>
      chain(
        () => undefined,
        (calls) => {
          expect(table).toBe('Report');
          const matchesRow = wheres(calls).some(
            ([column, op, value]) => column === 'id' && op === '=' && value === existingReportId
          );
          return existingReportId !== undefined && matchesRow
            ? { id: existingReportId }
            : undefined;
        }
      ),
    updateTable: (table: string) =>
      chain(
        (calls) => updateSpy(calls),
        (calls) => {
          expect(table).toBe('Report');
          // Scoped, like the SELECT. Without this an UPDATE that lost `.where('id','=',id)` — which
          // rewrites the column on EVERY report in the table — resolved exactly like a correct one.
          expect(
            wheres(calls).map(([column]) => column),
            'an UPDATE here must be scoped to a single report'
          ).toContain('id');
          const returning = calls.some(([m]) => m === 'returning');
          if (!returning) return { numUpdatedRows: BigInt(affectedRows) };
          return updateResult;
        }
      ),
  },
}));

vi.mock('../mod-activity', () => ({ recordModActivity }));
vi.mock('../rewards', () => ({ rewardReportReporters }));
// The real cache helper with only the client stubbed, so the writes asserted below are the ones the
// service would actually issue.
vi.mock('../redis', () => ({
  getRedis: () => ({
    packed: { get: async () => null, set: async () => undefined },
    del: async () => 1,
    hmGet: async (_key: string, fields: string[]) => fields.map(() => null),
    hSetMultiWithExpire: redisMarkResolved,
    hDel: redisClearResolved,
  }),
}));

const { setReportStatus, updateReportNotes } = await import('../reports.service');

beforeEach(() => {
  vi.clearAllMocks();
  existingReportId = 1;
  updateResult = { userId: 10, alsoReportedBy: null };
  affectedRows = 1;
});

/** The `where` arguments the UPDATE was built with, as `[column, op, value]` triples. */
const updateWheres = () => wheres((updateSpy.mock.calls[0]?.[0] as Call[]) ?? []);

const updateSet = () =>
  (((updateSpy.mock.calls[0]?.[0] as Call[]) ?? []).find(([m]) => m === 'set')?.[1][0] ??
    {}) as Record<string, unknown>;

describe('setReportStatus', () => {
  it('refuses a report that no longer exists instead of reporting success', async () => {
    existingReportId = undefined;

    const result = await setReportStatus({ id: 404, status: ReportStatus.Actioned, userId: 7 });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('no longer exists') });
    // Nothing may follow the existence check — a forged id must not leave a ModActivity trail.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(recordModActivity).not.toHaveBeenCalled();
    expect(rewardReportReporters).not.toHaveBeenCalled();
  });

  it('looks the report up by the id it was asked about', async () => {
    existingReportId = 55;

    expect(await setReportStatus({ id: 55, status: ReportStatus.Actioned, userId: 7 })).toEqual({
      ok: true,
      changed: true,
    });
    expect(await setReportStatus({ id: 56, status: ReportStatus.Actioned, userId: 7 })).toEqual({
      ok: false,
      error: expect.stringContaining('no longer exists'),
    });
  });

  it('reports changed:false when another moderator already set that status', async () => {
    updateResult = undefined; // the `status != status` guard matched nothing

    const result = await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    expect(result).toEqual({ ok: true, changed: false });
  });

  it('does not re-reward a report that was already Actioned', async () => {
    updateResult = undefined;

    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    expect(rewardReportReporters).not.toHaveBeenCalled();
  });

  it('still records the review when the status was already set', async () => {
    // Deliberate: the moderator did work the report. Only a NONEXISTENT one is guarded against.
    updateResult = undefined;

    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    expect(recordModActivity).toHaveBeenCalledTimes(1);
  });

  it('keeps the status guard on the UPDATE, which is what makes changed:false reachable', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    expect(updateWheres()).toContainEqual(['status', '!=', ReportStatus.Actioned]);
    expect(updateWheres()).toContainEqual(['id', '=', 1]);
  });

  it('rewards the filer AND every also-reporter when the report is actioned', async () => {
    updateResult = { userId: 10, alsoReportedBy: [11, 12] };

    const result = await setReportStatus({
      id: 1,
      status: ReportStatus.Actioned,
      userId: 7,
      ip: '203.0.113.9',
    });

    expect(result).toEqual({ ok: true, changed: true });
    expect(rewardReportReporters).toHaveBeenCalledWith({
      reportId: 1,
      reporterIds: [10, 11, 12],
      ip: '203.0.113.9',
    });
  });

  it('stamps previouslyReviewedCount when actioning', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    expect(updateSet()).toHaveProperty('previouslyReviewedCount');
  });

  it('rewards nobody for a non-Actioned status, and does not stamp previouslyReviewedCount', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Unactioned, userId: 7 });

    expect(rewardReportReporters).not.toHaveBeenCalled();
    expect(updateSet()).not.toHaveProperty('previouslyReviewedCount');
    expect(updateSet()).toMatchObject({ status: ReportStatus.Unactioned, statusSetBy: 7 });
  });

  it('marks the report resolved, so a lagging replica cannot hand it straight back', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    // The dashboard re-reads the list the moment a save returns, and that read is a replica while
    // this write went to the primary.
    expect(redisMarkResolved).toHaveBeenCalledWith(
      expect.stringContaining('report:resolved-recent'),
      ['1', '1'],
      expect.any(Number)
    );
  });

  it('keeps the marker well past any replica lag', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Actioned, userId: 7 });

    const [, , ttl] = redisMarkResolved.mock.calls[0] as [string, string[], number];
    expect(ttl).toBeGreaterThan(60);
  });

  it('clears the marker when a report is put back in the queue', async () => {
    await setReportStatus({ id: 1, status: ReportStatus.Pending, userId: 7 });

    // `/reports/[slug]` offers Pending like any other status. Marking that resolved would hide a
    // report that is genuinely waiting for someone.
    expect(redisClearResolved).toHaveBeenCalledWith(
      expect.stringContaining('report:resolved-recent'),
      '1'
    );
    expect(redisMarkResolved).not.toHaveBeenCalled();
  });

  it('marks nothing when the report was not there to action', async () => {
    existingReportId = undefined;

    await setReportStatus({ id: 404, status: ReportStatus.Actioned, userId: 7 });

    expect(redisMarkResolved).not.toHaveBeenCalled();
    expect(redisClearResolved).not.toHaveBeenCalled();
  });

  it('records who actioned it, on every path that touched the row', async () => {
    existingReportId = 42;

    await setReportStatus({ id: 42, status: ReportStatus.Actioned, userId: 7 });

    expect(recordModActivity).toHaveBeenCalledWith({
      userId: 7,
      entityType: 'report',
      entityId: 42,
      activity: 'review',
    });
  });
});

describe('updateReportNotes', () => {
  it('reports the notes stored when the report was there', async () => {
    expect(await updateReportNotes({ id: 1, internalNotes: 'spam ring' })).toEqual({ ok: true });
  });

  it('reports `gone` when the row was deleted while the notes were being typed', async () => {
    affectedRows = 0;

    expect(await updateReportNotes({ id: 1, internalNotes: 'spam ring' })).toEqual({
      ok: false,
      gone: true,
    });
  });
});
