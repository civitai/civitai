import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { clearUserProfileFields, type ProfileClearSnapshot } from '~/server/services/user.service';

const db = dbMock.dbWrite;
const USER = 990100001;
const MOD = 990100002;
const stored = {
  bio: 'b',
  message: 'm',
  messageAddedAt: null,
  sfwBio: 'sb',
  sfwMessage: null,
  location: 'l',
  showcaseSections: [{ key: 'k' }],
};
let archive: ReturnType<typeof vi.fn<(s: ProfileClearSnapshot) => Promise<unknown>>>;

beforeEach(() => {
  vi.clearAllMocks();
  db.userProfile.updateMany.mockResolvedValue({ count: 1 } as never);
  db.userProfile.findUnique.mockResolvedValue(stored as never);
  db.csamReport.findFirst.mockResolvedValue(null as never);
  db.modActivity.create.mockResolvedValue({} as never);
  db.userLink.findMany.mockResolvedValue([] as never);
  archive = vi.fn(async () => ({}));
});

const clear = (args: Partial<Parameters<typeof clearUserProfileFields>[0]> = {}) =>
  clearUserProfileFields({ userId: USER, actorId: MOD, archive, ...args });

// Showcase titles and button links are profile text a moderator must be able to clear.
describe('clearUserProfileFields', () => {
  it('clears custom showcase sections by default', async () => {
    await clear();
    expect(db.userProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: USER },
      data: expect.objectContaining({ showcaseSections: [], bio: null, message: null }),
    });
  });

  it('leaves them when only other fields are named', async () => {
    await clear({ fields: ['bio'] });
    const { data } = db.userProfile.updateMany.mock.calls[0][0] as { data: object };
    expect(data).not.toHaveProperty('showcaseSections');
  });

  it('counts the user named second on a report as reported', async () => {
    await clear();
    const where = db.csamReport.findFirst.mock.calls[0][0]?.where as { OR: unknown[] };
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { userId: USER },
        { details: { path: ['secondaryUserId'], equals: USER } },
        { details: { path: ['secondaryUserId'], equals: String(USER) } },
      ])
    );
  });

  it('archives again when the text changes during the upload', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    const edited = { ...stored, bio: 'edited' };
    db.userProfile.findUnique
      .mockResolvedValueOnce(stored as never)
      .mockResolvedValueOnce(edited as never)
      .mockResolvedValue(edited as never);
    await clear();
    expect(archive.mock.calls.map(([s]) => s.profile?.bio)).toEqual(['b', 'edited']);
    // Read, archive, read (changed), archive, read (settled), then clear.
    expect(db.userProfile.findUnique).toHaveBeenCalledTimes(3);
    expect(db.userProfile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses to clear a profile that keeps changing while it is archived', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    let reads = 0;
    db.userProfile.findUnique.mockImplementation((async () => {
      // A loop with no cap fails here instead of hanging.
      if (++reads > 20) throw new Error('read loop did not end');
      return { ...stored, bio: `v${reads}` };
    }) as never);
    await expect(clear()).rejects.toThrow('kept changing');
    expect(archive).toHaveBeenCalledTimes(3);
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('archives the social and sponsorship links with the text', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    const links = [{ id: 1, url: 'https://example.invalid/pay', type: 'Sponsorship' }];
    db.userLink.findMany.mockResolvedValue(links as never);
    await clear();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ links }));
  });

  it('archives the links of a user who has links but no profile row', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    db.userProfile.findUnique.mockResolvedValue(null as never);
    const links = [{ id: 1, url: 'https://example.invalid/pay', type: 'Sponsorship' }];
    db.userLink.findMany.mockResolvedValue(links as never);
    await clear();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ profile: null, links }));
  });

  it('writes no archive and no record when the user has no profile row', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    db.userProfile.findUnique.mockResolvedValue(null as never);
    db.userProfile.updateMany.mockResolvedValue({ count: 0 } as never);
    await clear();
    expect(archive).not.toHaveBeenCalled();
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });

  it('records who cleared the profile, on every clear', async () => {
    await clear();
    expect(db.modActivity.create).toHaveBeenCalledWith({
      data: { userId: MOD, activity: 'clearProfile', entityType: 'User', entityId: USER },
    });
  });

  it('does not archive the profile of a user with no CSAM report', async () => {
    await clear();
    expect(archive).not.toHaveBeenCalled();
    expect(db.userProfile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('archives the stored text, showcase sections included, before clearing a reported user', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    await clear({ fields: ['bio', 'showcaseSections'] });
    expect(archive).toHaveBeenCalledWith({
      userId: USER,
      actorId: MOD,
      clearedFields: ['bio', 'showcaseSections'],
      profile: stored,
      links: [],
    });
    expect(db.userProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: USER },
      select: Object.fromEntries(Object.keys(stored).map((k) => [k, true])),
    });
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(
      db.userProfile.updateMany.mock.invocationCallOrder[0]
    );
  });

  it('archives first when asked to, report or not', async () => {
    await clear({ alwaysArchive: true });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('clears nothing when the archive fails', async () => {
    db.csamReport.findFirst.mockResolvedValue({ id: 990200001 } as never);
    archive.mockRejectedValueOnce(new Error('upload failed'));
    await expect(clear()).rejects.toThrow('upload failed');
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
    expect(db.modActivity.create).not.toHaveBeenCalled();
  });
});
