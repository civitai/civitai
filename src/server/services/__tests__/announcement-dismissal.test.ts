import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  activeAnnouncementWhere,
  dismissAnnouncementsForUser,
  getDismissedAnnouncementIds,
} from '~/server/services/announcement.service';
import { DomainColor } from '~/shared/utils/prisma/enums';

const NOW = new Date('2026-09-16T12:00:00.000Z');

const liveLookup = dbMock.dbWrite.announcement.findMany;
const createMany = dbMock.dbWrite.announcementDismissal.createMany;
const dismissalLookup = dbMock.dbRead.announcementDismissal.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dismissAnnouncementsForUser', () => {
  it('writes only the ids that name a live announcement', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);
    createMany.mockResolvedValue({ count: 1 });

    const result = await dismissAnnouncementsForUser({ userId: 3, ids: [7, 8] });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toEqual([{ userId: 3, announcementId: 7 }]);
    expect(result).toEqual({ dismissed: 1 });
  });

  /**
   * 8 is not a live announcement id, and the client can send any number it likes. Unfiltered it
   * reaches the foreign key, which fails the whole request — including the id that was real.
   */
  it('checks the ids against the live window on the writer, not the replica', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);
    createMany.mockResolvedValue({ count: 1 });

    await dismissAnnouncementsForUser({ userId: 3, ids: [7, 8] });

    expect(dbMock.dbRead.announcement.findMany).not.toHaveBeenCalled();
    expect(liveLookup.mock.calls[0][0].where).toEqual({
      id: { in: [7, 8] },
      ...activeAnnouncementWhere(NOW),
    });
  });

  it('writes nothing when no id is live', async () => {
    liveLookup.mockResolvedValue([]);

    const result = await dismissAnnouncementsForUser({ userId: 3, ids: [8] });

    expect(createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ dismissed: 0 });
  });

  it('is idempotent on a repeat dismissal', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);
    createMany.mockResolvedValue({ count: 0 });

    await dismissAnnouncementsForUser({ userId: 3, ids: [7] });

    expect(createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });
});

describe('getDismissedAnnouncementIds', () => {
  it('returns the dismissed ids', async () => {
    dismissalLookup.mockResolvedValue([{ announcementId: 4 }, { announcementId: 9 }]);

    expect(await getDismissedAnnouncementIds({ userId: 3 })).toEqual([4, 9]);
  });

  /**
   * 🔴 The bound on this response, and the reason the table can grow. Without the join a user
   * who has dismissed announcements for two years is shipped every id they ever dismissed, on
   * every session, and the client is left to work out which ones still matter.
   *
   * The expectation is built from `activeAnnouncementWhere` rather than restating the predicate,
   * so this stays true when the predicate changes and fails when the read stops using it — the
   * repo has a guard family about one rule derived twice. The second assertion is what keeps it
   * from passing vacuously if that helper ever returned an empty filter.
   */
  it('scopes the query to announcements that can still be shown', async () => {
    await getDismissedAnnouncementIds({ userId: 3 });

    const where = dismissalLookup.mock.calls[0][0].where;
    expect(where).toEqual({ userId: 3, announcement: activeAnnouncementWhere(NOW) });
    expect(activeAnnouncementWhere(NOW)).toMatchObject({ disabled: false });
  });

  it('narrows to the requesting domain when one is stamped', async () => {
    await getDismissedAnnouncementIds({ userId: 3, domain: DomainColor.green });

    expect(dismissalLookup.mock.calls[0][0].where.announcement).toEqual({
      ...activeAnnouncementWhere(NOW),
      domain: { hasSome: [DomainColor.all, DomainColor.green] },
    });
  });
});
