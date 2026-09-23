import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { announcementDismissalCleanupJob } from '~/server/jobs/announcement-dismissal-cleanup';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const CUTOFF = new Date('2026-06-18T12:00:00.000Z'); // NOW - 90 days

const retiredLookup = dbMock.dbRead.announcement.findMany;
const deleteMany = dbMock.dbWrite.announcementDismissal.deleteMany;

function run() {
  return announcementDismissalCleanupJob.run({}).result;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  deleteMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('announcement-dismissal-cleanup', () => {
  /**
   * 🔴 The direction of this comparison is the whole job. Reversed, it deletes the dismissals of
   * every announcement that is still being shown — which resurfaces them for everyone who
   * dismissed them, the defect this table exists to fix.
   */
  it('selects announcements retired before the grace period, never recent ones', async () => {
    retiredLookup.mockResolvedValue([]);

    await run();

    const { OR } = retiredLookup.mock.calls[0][0].where;
    // Asserted on its own first: a whole-object diff renders the nested comparison as `…(1)`,
    // which does not name the operator this test is about.
    expect(OR[0].endsAt).toEqual({ lt: CUTOFF });
    expect(OR).toEqual([{ endsAt: { lt: CUTOFF } }, { disabled: true, updatedAt: { lt: CUTOFF } }]);
  });

  /**
   * A moderator retires an announcement by disabling it, usually without setting `endsAt` — and
   * edits it back months later. Both arms are needed: the first alone collects nothing for a
   * disabled row, and `updatedAt` is what restarts the grace period on that edit.
   */
  it('reaches a disabled announcement that never had an end date', async () => {
    retiredLookup.mockResolvedValue([]);

    await run();

    const { OR } = retiredLookup.mock.calls[0][0].where;
    expect(OR).toContainEqual({ disabled: true, updatedAt: { lt: CUTOFF } });
  });

  it('deletes the dismissals of the announcements it selected', async () => {
    retiredLookup.mockResolvedValue([{ id: 4 }, { id: 9 }]);
    deleteMany.mockResolvedValue({ count: 3 });

    const result = await run();

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where).toEqual({ announcementId: { in: [4, 9] } });
    expect(result).toEqual({ deleted: 3 });
  });

  it('writes through the writer and reads through the replica', async () => {
    retiredLookup.mockResolvedValue([{ id: 4 }]);

    await run();

    // The positive half. Without it this test is green when the job issues nothing at all, or
    // when either statement moves to a path these two mocks do not cover.
    expect(retiredLookup).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.announcement.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.announcementDismissal.deleteMany).not.toHaveBeenCalled();
  });

  it('issues nothing when no announcement has retired', async () => {
    retiredLookup.mockResolvedValue([]);

    const result = await run();

    expect(deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0 });
  });

  /**
   * Unbounded, this is one statement with an id list as long as the `Announcement` table — ~25k
   * once the profile-banner backfill lands. The assertion reads the chunk sizes rather than the
   * call count so a changed chunk size fails by naming the size.
   */
  it('splits the delete into bounded statements', async () => {
    retiredLookup.mockResolvedValue(Array.from({ length: 1101 }, (_, i) => ({ id: i + 1 })));

    await run();

    expect(deleteMany.mock.calls.map((call) => call[0].where.announcementId.in.length)).toEqual([
      500, 500, 101,
    ]);
  });
});
