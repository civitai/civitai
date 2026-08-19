import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The property under test is that a creator write cannot reach a sitewide surface, and it
// is enforced structurally rather than by a check: the creator schema has no `metadata.type`
// field, and the creator service pins `userId` itself. Both halves are asserted with a
// positive control beside them, so a schema that rejected everything (or a service that
// wrote nothing) would fail here rather than pass by producing an absence.

vi.mock('~/server/services/cover-image.service', () => ({
  resolveCoverImageId: vi.fn(async () => 555),
}));
vi.mock('~/server/services/util.service', () => ({ isImageOwner: vi.fn(async () => true) }));
vi.mock('~/server/services/announcement-allowance.service', () => ({
  getAnnouncementAllowance: vi.fn(async () => ({
    eligible: true,
    tier: 'gold',
    score: 50_000,
    minScore: 10_000,
    used: 0,
    limit: 2,
    windowDays: 7,
    nextAvailableAt: null,
  })),
}));

import { upsertCreatorAnnouncementSchema } from '~/server/schema/announcement.schema';
import {
  deleteCreatorAnnouncement,
  getCreatorAnnouncements,
  getFollowedAnnouncements,
  upsertCreatorAnnouncement,
} from '../creator-announcement.service';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';

const AUTHOR = 101;

const validInput = {
  title: 'New LoRA is up',
  content: 'Trained on a fresh dataset.',
  domain: ['all'] as ['all'],
  profileOnly: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  // The spend check runs inside a transaction behind a per-creator advisory lock, so the
  // callback has to actually execute for the cap to be exercised at all.
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: unknown) =>
    (fn as (tx: unknown) => Promise<unknown>)(dbMock.dbWrite)
  );
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
  dbMock.dbWrite.announcementSpend.count.mockResolvedValue(0 as never);
  dbMock.dbWrite.announcementSpend.create.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.announcement.create.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.announcement.update.mockResolvedValue({ id: 1 } as never);
  dbMock.dbWrite.announcement.delete.mockResolvedValue({ id: 1 } as never);
  dbMock.dbRead.announcement.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.announcement.findFirst.mockResolvedValue({
    id: 1,
    coverId: null,
    profileOnly: false,
  } as never);
});

describe('creator announcement schema is the boundary', () => {
  it('keeps the fields a creator is allowed to set', () => {
    const parsed = upsertCreatorAnnouncementSchema.parse({
      ...validInput,
      domain: ['green'],
    });

    // Positive control: without this, "the sitewide fields are gone" would also pass for
    // a schema that dropped everything.
    expect(parsed.title).toBe(validInput.title);
    expect(parsed.content).toBe(validInput.content);
    expect(parsed.domain).toEqual(['green']);
  });

  it('drops sitewide reach and audience-forging fields instead of accepting them', () => {
    const parsed = upsertCreatorAnnouncementSchema.parse({
      ...validInput,
      metadata: { type: 'site', colSpan: 12 },
      targetUserIds: [1, 2, 3],
      notifyTargetedUsers: true,
      userId: 999,
    }) as Record<string, unknown>;

    expect(parsed.metadata).toBeUndefined();
    expect(parsed.targetUserIds).toBeUndefined();
    expect(parsed.notifyTargetedUsers).toBeUndefined();
    expect(parsed.userId).toBeUndefined();
  });
});

describe('creator announcement service pins the author and the surface', () => {
  it('writes the caller as author and a metadata blob with no type', async () => {
    await upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR });

    const args = dbMock.dbWrite.announcement.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };

    expect(args.data.userId).toBe(AUTHOR);
    expect(args.data.title).toBe(validInput.title);
    expect(args.data.metadata).toBeDefined();
    expect((args.data.metadata as Record<string, unknown>).type).toBeUndefined();
  });

  it('refuses to load, edit or delete a row it does not author', async () => {
    dbMock.dbRead.announcement.findFirst.mockResolvedValue(null as never);

    await expect(
      upsertCreatorAnnouncement({ ...validInput, id: 7, userId: AUTHOR })
    ).rejects.toThrow();
    await expect(deleteCreatorAnnouncement({ id: 7, userId: AUTHOR })).rejects.toThrow();

    // Both lookups scoped to the caller, so a platform row (userId null) is unreachable.
    for (const call of dbMock.dbRead.announcement.findFirst.mock.calls) {
      expect((call[0] as { where: { userId: number } }).where.userId).toBe(AUTHOR);
    }
    expect(dbMock.dbWrite.announcement.delete).not.toHaveBeenCalled();
  });

  it('scopes reads to one author', async () => {
    await getCreatorAnnouncements({ userId: AUTHOR });

    const where = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as { where: { userId: number } }
    ).where;
    expect(where.userId).toBe(AUTHOR);
  });
});

describe('the allowance gates a notifying announcement and not a profile-only one', () => {
  it('rejects a new announcement when the score floor is not met', async () => {
    vi.mocked(getAnnouncementAllowance).mockResolvedValueOnce({
      eligible: false,
      tier: 'free',
      score: 900,
      minScore: 10_000,
      used: 0,
      limit: 1,
      windowDays: 30,
      nextAvailableAt: null,
    });

    await expect(upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR })).rejects.toThrow(
      /creator score/i
    );
    expect(dbMock.dbWrite.announcement.create).not.toHaveBeenCalled();
  });

  it('rejects when the period is spent, and says when it returns', async () => {
    vi.mocked(getAnnouncementAllowance).mockResolvedValueOnce({
      eligible: true,
      tier: 'free',
      score: 50_000,
      minScore: 10_000,
      used: 1,
      limit: 1,
      windowDays: 30,
      nextAvailableAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    // Re-counted inside the transaction rather than trusted from the read above, so two
    // concurrent creates cannot both pass on the same stale count.
    dbMock.dbWrite.announcementSpend.count.mockResolvedValue(1 as never);

    await expect(upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR })).rejects.toThrow(
      /Next available/
    );
    expect(dbMock.dbWrite.announcement.create).not.toHaveBeenCalled();
  });

  it('does not consult the allowance for a profile-only announcement', async () => {
    await upsertCreatorAnnouncement({ ...validInput, profileOnly: true, userId: AUTHOR });

    expect(getAnnouncementAllowance).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.announcement.create).toHaveBeenCalled();
  });
});

describe('a moderator may remove an authored announcement, never a platform one', () => {
  it('widens the lookup to any authored row, and still excludes platform rows', async () => {
    await deleteCreatorAnnouncement({ id: 7, userId: 999, isModerator: true });

    const where = (
      dbMock.dbRead.announcement.findFirst.mock.calls[0][0] as {
        where: { id: number; userId: unknown };
      }
    ).where;

    expect(where.id).toBe(7);
    // Not the caller's id (they don't own it) but not unrestricted either: a platform
    // row has userId null and must stay out of reach of this path.
    expect(where.userId).toEqual({ not: null });
    expect(dbMock.dbWrite.announcement.delete).toHaveBeenCalled();
  });

  it('still scopes a non-moderator delete to the caller', async () => {
    await deleteCreatorAnnouncement({ id: 7, userId: 101 });

    const where = (
      dbMock.dbRead.announcement.findFirst.mock.calls[0][0] as { where: { userId: unknown } }
    ).where;
    expect(where.userId).toBe(101);
  });
});

describe('reads are scoped to the requesting domain', () => {
  it('filters the profile read, so a green visitor cannot see the non-green banner', async () => {
    await getCreatorAnnouncements({ userId: AUTHOR, domain: 'green' as never });

    const where = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as {
        where: { domain?: { hasSome: string[] }; userId: number };
      }
    ).where;

    expect(where.domain?.hasSome).toEqual(['all', 'green']);
    // Positive control: the author scope is still the primary filter.
    expect(where.userId).toBe(AUTHOR);
  });

  it('does not invent a domain filter when the host supplies none', async () => {
    await getCreatorAnnouncements({ userId: AUTHOR });

    const where = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as { where: { domain?: unknown } }
    ).where;
    expect(where.domain).toBeUndefined();
  });
});

describe('the followed feed', () => {
  const feedRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: 100 - i,
      metadata: {},
      cover: null,
    }));

  it('asks for followers of the author, not the authors they follow', async () => {
    await getFollowedAnnouncements({ userId: AUTHOR });

    const where = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as {
        where: {
          user: {
            AND: { engagedUsers?: { some?: unknown; none?: unknown } }[];
            engagingUsers: unknown;
          };
        };
      }
    ).where;

    // engagedUsers = rows where the author is the TARGET. engagingUsers on the `some`
    // side would be "authors this person follows", a plausible and wrong feed.
    expect(where.user.AND[0].engagedUsers?.some).toEqual({ userId: AUTHOR, type: 'Follow' });
  });

  it('excludes profile-only rows, which notify and feed nobody', async () => {
    await getFollowedAnnouncements({ userId: AUTHOR });

    const where = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as {
        where: { profileOnly: boolean; disabled: boolean; userId: unknown };
      }
    ).where;

    expect(where.profileOnly).toBe(false);
    expect(where.disabled).toBe(false);
    // Platform rows have a null author and belong to the sitewide banner, not this feed.
    expect(where.userId).toEqual({ not: null });
  });

  it('drops a muted creator and either side of a block', async () => {
    await getFollowedAnnouncements({ userId: AUTHOR });

    const user = (
      dbMock.dbRead.announcement.findMany.mock.calls[0][0] as {
        where: {
          user: {
            announcementMutesReceived: { none: unknown };
            engagingUsers: { none: unknown };
            AND: { engagedUsers?: { none?: { type?: { in?: string[] } } } }[];
          };
        };
      }
    ).where.user;

    expect(user.announcementMutesReceived.none).toEqual({ userId: AUTHOR });
    expect(user.engagingUsers.none).toEqual({ targetUserId: AUTHOR, type: 'Block' });
    expect(user.AND[1].engagedUsers?.none?.type?.in).toEqual(['Block', 'Hide']);
  });

  it('pages with a cursor and reports one only when a further page exists', async () => {
    dbMock.dbRead.announcement.findMany.mockResolvedValue(feedRows(3) as never);

    const page = await getFollowedAnnouncements({ userId: AUTHOR, limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe(page.items[1].id);

    dbMock.dbRead.announcement.findMany.mockResolvedValue(feedRows(2) as never);
    const last = await getFollowedAnnouncements({ userId: AUTHOR, limit: 2 });
    expect(last.items).toHaveLength(2);
    expect(last.nextCursor).toBeUndefined();
  });

  it('skips the cursor row itself so a page never repeats its predecessor', async () => {
    await getFollowedAnnouncements({ userId: AUTHOR, limit: 5, cursor: 77 });

    const args = dbMock.dbRead.announcement.findMany.mock.calls[0][0] as {
      take: number;
      skip?: number;
      cursor?: { id: number };
    };

    expect(args.cursor).toEqual({ id: 77 });
    expect(args.skip).toBe(1);
    // limit + 1: the extra row is how nextCursor knows there is more, and must not be
    // returned to the caller.
    expect(args.take).toBe(6);
  });
});

describe('the allowance cannot be walked around', () => {
  it('charges an update that turns a free profile-only row into a notifying one', async () => {
    dbMock.dbRead.announcement.findFirst.mockResolvedValue({
      id: 9,
      coverId: null,
      profileOnly: true,
    } as never);

    await upsertCreatorAnnouncement({ ...validInput, id: 9, profileOnly: false, userId: AUTHOR });

    // The flip is the moment it gains an audience, so it pays here. Checking only for a
    // new row let a creator mint free profile-only rows and flip them into fan-outs.
    expect(getAnnouncementAllowance).toHaveBeenCalledWith(AUTHOR);
    expect(dbMock.dbWrite.announcementSpend.create).toHaveBeenCalled();
  });

  it('does not charge twice for editing an announcement that already notified', async () => {
    dbMock.dbRead.announcement.findFirst.mockResolvedValue({
      id: 9,
      coverId: null,
      profileOnly: false,
    } as never);

    await upsertCreatorAnnouncement({ ...validInput, id: 9, userId: AUTHOR });

    expect(getAnnouncementAllowance).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.announcementSpend.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.announcement.update).toHaveBeenCalled();
  });

  it('records the spend against the row it paid for', async () => {
    dbMock.dbWrite.announcement.create.mockResolvedValue({ id: 55 } as never);

    await upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR });

    expect(dbMock.dbWrite.announcementSpend.create).toHaveBeenCalledWith({
      data: { userId: AUTHOR, announcementId: 55 },
    });
  });

  it('takes a per-creator lock before counting, so two creates cannot both pass', async () => {
    await upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR });

    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalled();
    const [strings] = dbMock.dbWrite.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray];
    expect(strings.join('')).toContain('pg_advisory_xact_lock');
  });
});

describe('an omitted field means leave it alone', () => {
  it('does not clear `disabled` on an update that never mentions it', async () => {
    dbMock.dbRead.announcement.findFirst.mockResolvedValue({
      id: 9,
      coverId: null,
      profileOnly: false,
    } as never);

    await upsertCreatorAnnouncement({ ...validInput, id: 9, userId: AUTHOR });

    const data = (
      dbMock.dbWrite.announcement.update.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;

    // A row a moderator disabled would otherwise go live again the moment its author
    // fixed a typo — and that path spends no slot, so the restore would be free.
    expect('disabled' in data).toBe(false);
    // Positive control: the edit still writes the fields it did send.
    expect(data.title).toBe(validInput.title);
  });

  it('still honours an explicit disabled on an update', async () => {
    dbMock.dbRead.announcement.findFirst.mockResolvedValue({
      id: 9,
      coverId: null,
      profileOnly: false,
    } as never);

    await upsertCreatorAnnouncement({ ...validInput, id: 9, disabled: true, userId: AUTHOR });

    const data = (
      dbMock.dbWrite.announcement.update.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.disabled).toBe(true);
  });

  it('defaults a new announcement to enabled', async () => {
    await upsertCreatorAnnouncement({ ...validInput, userId: AUTHOR });

    const data = (
      dbMock.dbWrite.announcement.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.disabled).toBe(false);
  });
});
