import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  clearUserProfileFields,
  removeUserLinkAsModerator,
  type ProfileClearField,
  type ProfileClearSnapshot,
} from '~/server/services/user.service';

const db = dbMock.dbWrite;

/** ModActivity rows written through `trackModActivity`: [actor, entityType, activity, entityIds]. */
const modActivityRows = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .filter(([s]) => (s as unknown as readonly string[]).join('?').includes('"ModActivity"'))
    .map(([, ...values]) => values);
/** The next ModActivity write fails; every other raw write succeeds. */
const failModActivityOnce = () => {
  let armed = true;
  dbMock.dbWrite.$executeRaw.mockImplementation((async (s: readonly string[]) => {
    if (armed && s.join('?').includes('"ModActivity"')) {
      armed = false;
      throw new Error('db blip');
    }
    return 0;
  }) as never);
};
/** Whether the CSAM report lookup names the user. */
const reportNames = (named: boolean) =>
  dbMock.dbWrite.$queryRaw.mockImplementation((async (s: readonly string[]) =>
    s.join('?').includes('"CsamReport"') ? [{ named }] : []) as never);
/**
 * Runs `$transaction` on a client of its own, so a write that skips the transaction lands on `db`
 * instead and shows. Returns that client.
 */
const separateTx = () => {
  const tx = {
    userProfile: { updateMany: vi.fn(async () => ({ count: 1 })) },
    userLink: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $executeRaw: vi.fn(async () => 1),
  };
  db.$transaction.mockImplementation((async (fn: (client: unknown) => unknown) => fn(tx)) as never);
  return tx;
};
const writesModActivity = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.some(([s]) => (s as readonly string[]).join('?').includes('"ModActivity"'));
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
  showcaseItems: [{ entityType: 'Model', entityId: 1 }],
  folderRows: [{ id: 'r', name: 'row text', folders: [] }],
};
const ALL_FIELDS: ProfileClearField[] = [
  'location',
  'bio',
  'message',
  'showcaseSections',
  'folderRows',
];
let archive: ReturnType<typeof vi.fn<(s: ProfileClearSnapshot) => Promise<unknown>>>;

beforeEach(() => {
  vi.clearAllMocks();
  db.userProfile.updateMany.mockResolvedValue({ count: 1 } as never);
  db.userProfile.findUnique.mockResolvedValue(stored as never);
  reportNames(false);
  db.$executeRaw.mockResolvedValue(0 as never);
  db.userLink.findMany.mockResolvedValue([] as never);
  archive = vi.fn(async () => ({}));
  db.$transaction.mockImplementation((async (fn: (client: unknown) => unknown) => fn(db)) as never);
});

const clear = (args: Partial<Parameters<typeof clearUserProfileFields>[0]> = {}) =>
  clearUserProfileFields({ userId: USER, actorId: MOD, archive, fields: ALL_FIELDS, ...args });

// Showcase titles and button links are profile text a moderator must be able to clear.
describe('clearUserProfileFields', () => {
  it('refuses an empty or missing field list, archiving and writing nothing', async () => {
    reportNames(true);
    await expect(clear({ fields: [] })).rejects.toThrow('at least one field');
    await expect(clear({ fields: undefined })).rejects.toThrow('at least one field');
    expect(archive).not.toHaveBeenCalled();
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
  });

  it('clears custom showcase sections when they are named', async () => {
    await clear();
    expect(db.userProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: USER },
      data: expect.objectContaining({ showcaseSections: [], bio: null, message: null }),
    });
  });

  it('clears folder row names when they are named, and archives them first', async () => {
    reportNames(true);
    await clear();
    expect(db.userProfile.updateMany).toHaveBeenCalledWith({
      where: { userId: USER },
      data: expect.objectContaining({ folderRows: [] }),
    });
    expect(db.userProfile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ folderRows: true }) })
    );
    expect(archive.mock.calls[0][0].profile?.folderRows).toEqual(stored.folderRows);
  });

  it('leaves them when only other fields are named', async () => {
    await clear({ fields: ['bio'] });
    const { data } = db.userProfile.updateMany.mock.calls[0][0] as { data: object };
    expect(data).not.toHaveProperty('showcaseSections');
  });

  it('archives again when the text changes during the upload', async () => {
    reportNames(true);
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
    reportNames(true);
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
    reportNames(true);
    const links = [{ id: 1, url: 'https://example.invalid/pay', type: 'Sponsorship' }];
    db.userLink.findMany.mockResolvedValue(links as never);
    await clear();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ links }));
  });

  it('archives the links of a user who has links but no profile row', async () => {
    reportNames(true);
    db.userProfile.findUnique.mockResolvedValue(null as never);
    const links = [{ id: 1, url: 'https://example.invalid/pay', type: 'Sponsorship' }];
    db.userLink.findMany.mockResolvedValue(links as never);
    await clear();
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ profile: null, links }));
  });

  it('writes no archive and no record when the user has no profile row', async () => {
    reportNames(true);
    db.userProfile.findUnique.mockResolvedValue(null as never);
    db.userProfile.updateMany.mockResolvedValue({ count: 0 } as never);
    await clear();
    expect(archive).not.toHaveBeenCalled();
    expect(modActivityRows()).toEqual([]);
  });

  it('clears and records on one transaction', async () => {
    const tx = separateTx();
    await expect(clear()).resolves.toEqual({ updated: true });
    expect(tx.userProfile.updateMany).toHaveBeenCalledTimes(1);
    expect(writesModActivity(tx.$executeRaw)).toBe(true);
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
    expect(modActivityRows()).toEqual([]);
  });

  it('fails the clear when its record fails to write', async () => {
    failModActivityOnce();
    await expect(clear()).rejects.toThrow('db blip');
  });

  it('records who cleared the profile, on every clear', async () => {
    await clear();
    expect(modActivityRows()).toEqual([[MOD, 'user', 'clearProfile', [USER]]]);
  });

  it('does not archive the profile of a user with no CSAM report', async () => {
    await clear();
    expect(archive).not.toHaveBeenCalled();
    expect(db.userProfile.updateMany).toHaveBeenCalledTimes(1);
  });

  it('archives the stored text, showcase sections and items included, before clearing a reported user', async () => {
    reportNames(true);
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
    reportNames(true);
    archive.mockRejectedValueOnce(new Error('upload failed'));
    await expect(clear()).rejects.toThrow('upload failed');
    expect(db.userProfile.updateMany).not.toHaveBeenCalled();
    expect(modActivityRows()).toEqual([]);
  });
});

describe('a report lookup that answers neither yes nor no', () => {
  it('archives when the lookup returns no row', async () => {
    db.$queryRaw.mockImplementation((async () => []) as never);
    await clear();
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('archives when the lookup returns NULL', async () => {
    db.$queryRaw.mockImplementation((async (s: readonly string[]) =>
      s.join('?').includes('"CsamReport"') ? [{ named: null }] : []) as never);
    await clear();
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

describe('removeUserLinkAsModerator', () => {
  const LINK = 990100003;
  const LINKS = [{ id: LINK, url: 'https://example.com/x', type: 'Social' }];
  const remove = () =>
    removeUserLinkAsModerator({ userId: USER, linkId: LINK, actorId: MOD, archive });

  beforeEach(() => {
    db.userLink.findMany.mockResolvedValue(LINKS as never);
    db.userLink.deleteMany.mockResolvedValue({ count: 1 } as never);
  });

  it('archives a reported user’s links before removing one, owner-scoped, and records it', async () => {
    reportNames(true);
    await expect(remove()).resolves.toEqual({ removed: true });
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ links: LINKS, clearedFields: ['links'] })
    );
    expect(db.userLink.deleteMany).toHaveBeenCalledWith({ where: { id: LINK, userId: USER } });
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(
      db.userLink.deleteMany.mock.invocationCallOrder[0]
    );
    expect(modActivityRows()).toEqual([[MOD, 'user', 'removeLink', [USER]]]);
  });

  it('removes nothing when the archive fails', async () => {
    reportNames(true);
    archive.mockRejectedValueOnce(new Error('upload failed'));
    await expect(remove()).rejects.toThrow('upload failed');
    expect(db.userLink.deleteMany).not.toHaveBeenCalled();
    expect(modActivityRows()).toEqual([]);
  });

  it('removes an unreported user’s link without an archive', async () => {
    await expect(remove()).resolves.toEqual({ removed: true });
    expect(archive).not.toHaveBeenCalled();
    expect(db.userLink.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('removes and records on one transaction', async () => {
    const tx = separateTx();
    await expect(remove()).resolves.toEqual({ removed: true });
    expect(tx.userLink.deleteMany).toHaveBeenCalledWith({ where: { id: LINK, userId: USER } });
    expect(writesModActivity(tx.$executeRaw)).toBe(true);
    expect(db.userLink.deleteMany).not.toHaveBeenCalled();
    expect(modActivityRows()).toEqual([]);
  });

  it('fails the removal when its record fails to write', async () => {
    failModActivityOnce();
    await expect(remove()).rejects.toThrow('db blip');
  });

  it('records nothing when the link is not that user’s', async () => {
    db.userLink.deleteMany.mockResolvedValue({ count: 0 } as never);
    await expect(remove()).resolves.toEqual({ removed: false });
    expect(modActivityRows()).toEqual([]);
  });
});
