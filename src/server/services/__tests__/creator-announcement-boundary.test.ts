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

    const where = (dbMock.dbRead.announcement.findMany.mock.calls[0][0] as { where: { userId: number } })
      .where;
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
