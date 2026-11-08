import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';

// The dismissed-ids read, one Kysely statement. Its live-window conditions, against a real
// database, are pinned in hot-reads-5.kysely-parity.test.ts.
const { dismissalLookup } = vi.hoisted(() => ({ dismissalLookup: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads5>()),
  listDismissedAnnouncementIds: dismissalLookup,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { kyselyRead } from '~/server/db/kyselyDb';
import {
  activeAnnouncementWhere,
  dismissAnnouncementsForUser,
  getDismissedAnnouncementIds,
} from '~/server/services/announcement.service';
import { DomainColor } from '~/shared/utils/prisma/enums';

const NOW = new Date('2026-09-16T12:00:00.000Z');

const liveLookup = dbMock.dbWrite.announcement.findMany;
const createMany = dbMock.dbWrite.announcementDismissal.createMany;

beforeEach(() => {
  vi.clearAllMocks();
  dismissalLookup.mockResolvedValue([]);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dismissAnnouncementsForUser', () => {
  it('writes only the ids that name a live announcement', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);

    await dismissAnnouncementsForUser({ userId: 3, ids: [7, 8] });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toEqual([{ userId: 3, announcementId: 7 }]);
  });

  /**
   * A count of the ids that matched is an oracle for "which of these announcements is live right
   * now", answerable by any signed-in caller against ids they cannot otherwise see.
   */
  it('tells the caller nothing about which ids were live', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);
    createMany.mockResolvedValue({ count: 1 });

    expect(await dismissAnnouncementsForUser({ userId: 3, ids: [7, 8] })).toBeUndefined();
  });

  /**
   * 8 is not a live announcement id, and the client can send any number it likes. Unfiltered it
   * reaches the foreign key, which fails the whole request — including the id that was real.
   */
  it('checks the ids against the live window on the writer, not the replica', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);

    await dismissAnnouncementsForUser({ userId: 3, ids: [7, 8] });

    expect(dbMock.dbRead.announcement.findMany).not.toHaveBeenCalled();
    expect(liveLookup.mock.calls[0][0].where).toEqual({
      id: { in: [7, 8] },
      ...activeAnnouncementWhere(NOW),
    });
  });

  it('writes nothing when no id is live', async () => {
    liveLookup.mockResolvedValue([]);

    await dismissAnnouncementsForUser({ userId: 3, ids: [8] });

    expect(createMany).not.toHaveBeenCalled();
  });

  it('is idempotent on a repeat dismissal', async () => {
    liveLookup.mockResolvedValue([{ id: 7 }]);

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
   * 🔴 The bound on this response, and the reason the table can grow. Without the live-window
   * join a user who has dismissed announcements for two years is shipped every id they ever
   * dismissed, on every session, and the client is left to work out which ones still matter.
   *
   * The window itself is SQL in the Kysely read (`activeAnnouncementWhere`'s twin), pinned against
   * a real database in hot-reads-5.kysely-parity.test.ts; the local half is that the read gets this
   * user and the current clock, on the replica.
   */
  it('scopes the query to announcements that can still be shown', async () => {
    await getDismissedAnnouncementIds({ userId: 3 });

    expect(dismissalLookup.mock.calls).toEqual([[kyselyRead, { userId: 3, now: NOW }]]);
    expect(dismissalLookup.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.announcementDismissal.findMany).not.toHaveBeenCalled();
  });

  it('narrows to the requesting domain when one is stamped', async () => {
    await getDismissedAnnouncementIds({ userId: 3, domain: DomainColor.green });

    expect(dismissalLookup.mock.calls[0][1].domains).toEqual([DomainColor.all, DomainColor.green]);
  });
});
