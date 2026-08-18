import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as CollectionService from '~/server/services/collection.service';
import type * as SessionClientModule from '~/server/auth/session-client';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `dbRead.collection.findUnique`, `dbRead.collectionContributor.findMany`, and
// `dbWrite.collectionInvite.deleteMany` aren't in the original brief's mock shape but the
// service calls all three (owner-protection lookup, roster query, invite cleanup on
// removal); stubbed here so those calls don't crash the suite. The `dbRead` trio also backs
// `countCollaborators`, which reads the caps off the replica. The owner-lookup default of
// OWNER_ID lets every test that targets someone other than the owner pass through untouched.
const { mockGetPermissions, mockCreateNotification, mockGetSessionUser } = vi.hoisted(() => {
  const OWNER_ID = 999;
  return {
    mockGetPermissions: vi.fn(),
    mockCreateNotification: vi.fn(),
    mockGetSessionUser: vi.fn(),
  };
});

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
}));

vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClientModule>()),
  sessionClient: { getSessionUserById: mockGetSessionUser },
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const {
  inviteCollaborator,
  respondToInvite,
  removeCollaborator,
  updateCollaboratorRole,
  getCollaborators,
  getMyInvites,
  COLLABORATOR_CAP,
  MANAGER_CAP,
} = await import('~/server/services/collection-collaborator.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;
const TARGET_ID = 555;

// The owner-lookup default every test that targets someone else passes through.
mockDbRead.collection.findUnique.mockResolvedValue({
  userId: OWNER_ID,
  read: 'Private',
  write: 'Private',
  mode: null,
});

function asOwner() {
  mockGetPermissions.mockResolvedValue({
    collectionId: COLLECTION_ID,
    isOwner: true,
    manage: true,
    read: true,
    collaborationDisabled: false,
    collectionMode: null,
  });
}

function asManager() {
  mockGetPermissions.mockResolvedValue({
    collectionId: COLLECTION_ID,
    isOwner: false,
    manage: true,
    read: true,
    collaborationDisabled: false,
    collectionMode: null,
  });
}

// `countCollaborators` now reads the raw rows, so the caps are arranged as the rows a
// Private collection would hold: every non-owner ADD/MANAGE row is elevated there (the free
// baseline is empty), which is the shape the cap arithmetic is defined over.
function arrangeCounts({ collaborators = 0, managers = 0 } = {}) {
  mockDbRead.collectionContributor.findMany.mockResolvedValue(
    Array.from({ length: collaborators }, (_, i) => ({
      userId: 2000 + i,
      permissions: i < managers ? ['VIEW', 'ADD', 'MANAGE'] : ['VIEW', 'ADD'],
    }))
  );
  mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
}

describe('inviteCollaborator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Private',
      write: 'Private',
      mode: null,
    });
    arrangeCounts();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'gold' });
    mockDbWrite.collectionInvite.upsert.mockResolvedValue({ id: 1 });
    mockDbRead.userEngagement.findFirst.mockResolvedValue(null);
  });

  it('lets the owner invite a Manager', async () => {
    asOwner();
    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Manager',
      isMember: true,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  it('notifies the invitee, never the inviter', async () => {
    asOwner();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      name: 'My Collection',
      read: 'Private',
      write: 'Private',
      mode: null,
    });

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_ID,
        type: 'collection-invite-received',
        details: { collectionId: COLLECTION_ID, collectionName: 'My Collection' },
      })
    );
    expect(mockCreateNotification.mock.calls.every((call) => call[0].userId !== OWNER_ID)).toBe(
      true
    );
  });

  it('refuses a Manager granting Manager', async () => {
    asManager();
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: MANAGER_ID,
        targetUserId: TARGET_ID,
        role: 'Manager',
      })
    ).rejects.toThrow();
  });

  it('lets a Manager invite a Contributor', async () => {
    asManager();
    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: MANAGER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  it('refuses to invite the owner', async () => {
    asOwner();
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: OWNER_ID,
        role: 'Contributor',
      })
    ).rejects.toThrow();
  });

  it('refuses to invite a user on either side of a block, and sends no notification', async () => {
    asOwner();
    mockDbRead.userEngagement.findFirst.mockResolvedValue({ userId: OWNER_ID });

    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
        isMember: true,
      })
    ).rejects.toThrow(/cannot invite this user/i);

    expect(mockDbWrite.collectionInvite.upsert).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  // Asserts the query, not just the refusal: a guard written in one direction
  // still passes the test above, because the mock answers regardless of `where`.
  it('looks for a block in both directions', async () => {
    asOwner();

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });

    expect(mockDbRead.userEngagement.findFirst).toHaveBeenCalledTimes(1);
    const { where } = mockDbRead.userEngagement.findFirst.mock.calls[0][0];
    expect(where.type).toBe('Block');
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { userId: OWNER_ID, targetUserId: TARGET_ID },
        { userId: TARGET_ID, targetUserId: OWNER_ID },
      ])
    );
  });

  it('refuses when collaboration is disabled', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: true,
      manage: true,
      collaborationDisabled: true,
      collectionMode: null,
    });
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
      })
    ).rejects.toThrow();
  });

  it('refuses past the collaborator cap', async () => {
    asOwner();
    arrangeCounts({ collaborators: COLLABORATOR_CAP, managers: 0 });
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
        isMember: true,
      })
    ).rejects.toThrow();
  });

  it('refuses past the manager cap but allows a contributor', async () => {
    asOwner();
    arrangeCounts({ collaborators: 6, managers: MANAGER_CAP });
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Manager',
        isMember: true,
      })
    ).rejects.toThrow();

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  // D1: the owner holds their own elevated {VIEW, ADD, MANAGE} row, so counting it left an
  // owner able to invite only 4 Managers and 24 collaborators.
  it('does not charge the owner a seat, so a full 5 Managers can still be invited', async () => {
    asOwner();
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: OWNER_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
      ...Array.from({ length: MANAGER_CAP - 1 }, (_, i) => ({
        userId: 3000 + i,
        permissions: ['VIEW', 'ADD', 'MANAGE'],
      })),
    ]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Manager',
      isMember: true,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  // I3: "Unfollow" deletes the contributor row but leaves the invite Accepted. Counting that
  // ghost burned a seat the roster no longer shows, so it could never be freed.
  it('releases the seat of an Accepted invite whose contributor row is gone', async () => {
    asOwner();
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue(
      Array.from({ length: COLLABORATOR_CAP }, (_, i) => ({
        userId: 4000 + i,
        role: 'Contributor',
        status: 'Accepted',
      }))
    );

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  // Counting only Accepted rows would let someone issue hundreds of invites and stay under the
  // cap until they all land, so the cap window — unlike the public roster — must span Pending.
  it('counts seats over both Accepted and non-expired Pending invites', async () => {
    asOwner();

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });

    const countQuery = mockDbRead.collectionInvite.findMany.mock.calls[0][0];
    expect(countQuery.where.OR).toEqual([
      { status: 'Accepted' },
      { status: 'Pending', createdAt: { gte: expect.any(Date) } },
    ]);
  });

  it('still charges a seat for an Accepted invite whose collaborator is present', async () => {
    asOwner();
    mockDbRead.collectionContributor.findMany.mockResolvedValue(
      Array.from({ length: COLLABORATOR_CAP }, (_, i) => ({
        userId: 4000 + i,
        permissions: ['VIEW', 'ADD'],
      }))
    );
    mockDbRead.collectionInvite.findMany.mockResolvedValue(
      Array.from({ length: COLLABORATOR_CAP }, (_, i) => ({
        userId: 4000 + i,
        role: 'Contributor',
        status: 'Accepted',
      }))
    );

    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
        isMember: true,
      })
    ).rejects.toThrow();
  });

  it('refuses on a Bookmark collection', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: true,
      manage: true,
      collaborationDisabled: false,
      collectionMode: 'Bookmark',
    });
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
      })
    ).rejects.toThrow();
  });
});

describe('inviteCollaborator — organic followers do not inflate the caps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.collectionInvite.upsert.mockResolvedValue({ id: 1 });
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'gold' });
    asOwner();
  });

  it('still succeeds when the only existing rows are followers on a write:Public collection', async () => {
    // COLLABORATOR_CAP plain followers, each carrying ADD for free (write:Public) — the
    // pre-fix filter (`permissions && ARRAY['ADD','MANAGE']`) would count every one of these
    // toward the cap and reject the invite below; the fix must see zero real collaborators.
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Public',
      mode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue(
      Array.from({ length: COLLABORATOR_CAP }, (_, i) => ({
        userId: 1000 + i,
        permissions: ['VIEW', 'ADD'],
      }))
    );
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });

    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  it('reads the caps off the replica without opening a write transaction', async () => {
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Private',
      write: 'Private',
      mode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: true,
    });

    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDbRead.collectionContributor.findMany).toHaveBeenCalled();
  });
});

// C1: the invite path had no membership gate at all, and pending invites write no
// contributor rows — so a free user could quietly build a 25-person shared collection that
// the reconciler never sees while the invites are outstanding.
describe('inviteCollaborator — membership gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Private',
      write: 'Private',
      mode: null,
    });
    arrangeCounts();
    mockDbWrite.collectionInvite.upsert.mockResolvedValue({ id: 1 });
  });

  it('refuses a free owner, even on a fully private collection', async () => {
    asOwner();
    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
        isMember: false,
      })
    ).rejects.toThrow(/membership/i);
    expect(mockDbWrite.collectionInvite.upsert).not.toHaveBeenCalled();
  });

  it('refuses a member Manager inviting on behalf of a lapsed owner', async () => {
    asManager();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'free' });

    await expect(
      inviteCollaborator({
        collectionId: COLLECTION_ID,
        userId: MANAGER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
        isMember: true,
      })
    ).rejects.toThrow(/membership/i);
    expect(mockGetSessionUser).toHaveBeenCalledWith(OWNER_ID);
    expect(mockDbWrite.collectionInvite.upsert).not.toHaveBeenCalled();
  });

  it('lets a Manager invite when the OWNER holds the membership', async () => {
    asManager();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'bronze' });

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: MANAGER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isMember: false,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  it('lets a moderator through without resolving a tier', async () => {
    asManager();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'free' });

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: MANAGER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
      isModerator: true,
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });
});

describe('respondToInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Private',
      write: 'Private',
      mode: null,
    });
  });

  it('writes the role bits plus whatever the collection grants for free', async () => {
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Review',
      mode: null,
    });
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: new Date(),
    });
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        collectionInvite: { update: mockDbWrite.collectionInvite.update },
        collectionContributor: { upsert: mockDbWrite.collectionContributor.upsert },
      })
    );

    await respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: true });

    const upsertArgs = mockDbWrite.collectionContributor.upsert.mock.calls[0][0];
    expect(new Set(upsertArgs.update.permissions)).toEqual(
      new Set(['VIEW', 'ADD', 'MANAGE', 'ADD_REVIEW'])
    );
  });

  // Rebuilt from the invite's role rather than unioned onto the stored row: unioning makes
  // accepting a Contributor invite a no-op for anyone who already holds MANAGE, which is how a
  // collaborator kept reading as a Manager after being re-invited as a Contributor.
  it('does not carry a stored MANAGE bit into a Contributor seat', async () => {
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Contributor',
      status: 'Pending',
      createdAt: new Date(),
    });
    mockDbWrite.collectionContributor.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'ADD', 'MANAGE'],
    });
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        collectionInvite: { update: mockDbWrite.collectionInvite.update },
        collectionContributor: { upsert: mockDbWrite.collectionContributor.upsert },
      })
    );

    await respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: true });

    const upsertArgs = mockDbWrite.collectionContributor.upsert.mock.calls[0][0];
    expect(upsertArgs.update.permissions).not.toContain('MANAGE');
  });

  it('rejects an invite older than 7 days', async () => {
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: stale,
    });
    await expect(
      respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: true })
    ).rejects.toThrow();
  });

  it('refuses to let someone else answer an invite', async () => {
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: new Date(),
    });
    await expect(
      respondToInvite({ inviteId: 1, userId: MANAGER_ID, accept: true })
    ).rejects.toThrow();
  });

  // Declining must never be blocked by the mode guard — otherwise a stale invite on a
  // collection that flipped to Contest sits in the inbox until it expires.
  it('lets a user decline an invite on a collection that flipped to Contest', async () => {
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: new Date(),
    });
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Private',
      mode: 'Contest',
    });

    await expect(
      respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: false })
    ).resolves.toEqual({ accepted: false });
    expect(mockDbWrite.collectionInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Declined' }) })
    );
  });

  // M4: inviteCollaborator refuses Contest/Bookmark, so accepting must too — otherwise a
  // mode flipped after the invite was sent still lands a MANAGE grant.
  it('refuses to accept onto a collection that flipped to Contest after the invite', async () => {
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: new Date(),
    });
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Private',
      mode: 'Contest',
    });

    await expect(
      respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: true })
    ).rejects.toThrow();
    expect(mockDbWrite.collectionContributor.upsert).not.toHaveBeenCalled();
  });
});

describe('updateCollaboratorRole', () => {
  const contributorUpdate = vi.fn();
  const inviteUpdate = vi.fn();

  const arrangeSeat = ({
    permissions = ['VIEW', 'ADD'],
    seat = { id: 7, status: 'Accepted' } as { id: number; status: string } | null,
    read = 'Private',
    write = 'Private',
  } = {}) => {
    mockDbRead.collection.findUnique.mockResolvedValue({
      id: COLLECTION_ID,
      userId: OWNER_ID,
      read,
      write,
      mode: null,
    });
    mockDbWrite.collectionContributor.findUnique.mockResolvedValue(
      permissions ? { permissions } : null
    );
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue(seat);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    arrangeCounts();
    arrangeSeat();
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        collectionContributor: { update: contributorUpdate },
        collectionInvite: { update: inviteUpdate },
      })
    );
  });

  it('drops MANAGE when the owner demotes a Manager', async () => {
    asOwner();
    arrangeSeat({ permissions: ['VIEW', 'ADD', 'MANAGE'] });

    await updateCollaboratorRole({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });

    expect(contributorUpdate.mock.calls[0][0].data.permissions).not.toContain('MANAGE');
  });

  // `countCollaborators` reads the invite row's role as well as the stored bits, so a seat left
  // at its old role keeps occupying a Manager slot the roster no longer shows.
  it('moves the seats invite row to the new role', async () => {
    asOwner();
    arrangeSeat({ permissions: ['VIEW', 'ADD', 'MANAGE'] });

    await updateCollaboratorRole({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });

    expect(inviteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { role: 'Contributor' } })
    );
  });

  it('refuses a Manager promoting someone to Manager', async () => {
    asManager();

    await expect(
      updateCollaboratorRole({
        collectionId: COLLECTION_ID,
        userId: MANAGER_ID,
        targetUserId: TARGET_ID,
        role: 'Manager',
      })
    ).rejects.toThrow();
    expect(contributorUpdate).not.toHaveBeenCalled();
  });

  it('refuses a Manager demoting another Manager', async () => {
    asManager();
    arrangeSeat({ permissions: ['VIEW', 'ADD', 'MANAGE'] });

    await expect(
      updateCollaboratorRole({
        collectionId: COLLECTION_ID,
        userId: MANAGER_ID,
        targetUserId: TARGET_ID,
        role: 'Contributor',
      })
    ).rejects.toThrow();
    expect(contributorUpdate).not.toHaveBeenCalled();
  });

  it('refuses to promote past the manager cap', async () => {
    asOwner();
    arrangeCounts({ collaborators: MANAGER_CAP, managers: MANAGER_CAP });
    arrangeSeat();

    await expect(
      updateCollaboratorRole({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Manager',
      })
    ).rejects.toThrow(new RegExp(`at most ${MANAGER_CAP} managers`));
  });

  // A follower on a write:Public collection holds {VIEW, ADD} exactly like a Contributor, so
  // promoting off the bits alone would hand a Manager seat to anyone who clicked follow.
  it('refuses to promote a follower who holds no seat', async () => {
    asOwner();
    arrangeSeat({ permissions: ['VIEW', 'ADD'], seat: null, read: 'Public', write: 'Public' });

    await expect(
      updateCollaboratorRole({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: TARGET_ID,
        role: 'Manager',
      })
    ).rejects.toThrow(/not a collaborator/i);
  });

  it('refuses to change the owner', async () => {
    asOwner();

    await expect(
      updateCollaboratorRole({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: OWNER_ID,
        role: 'Contributor',
      })
    ).rejects.toThrow();
  });
});

describe('removeCollaborator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({ userId: OWNER_ID });
    mockDbWrite.collectionContributor.delete.mockResolvedValue({});
  });

  it('refuses to remove the owner', async () => {
    asOwner();
    await expect(
      removeCollaborator({
        collectionId: COLLECTION_ID,
        userId: OWNER_ID,
        targetUserId: OWNER_ID,
      })
    ).rejects.toThrow();
  });

  it('refuses a Manager removing another Manager', async () => {
    asManager();
    mockDbWrite.collectionContributor.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'ADD', 'MANAGE'],
    });
    await expect(
      removeCollaborator({
        collectionId: COLLECTION_ID,
        userId: MANAGER_ID,
        targetUserId: TARGET_ID,
      })
    ).rejects.toThrow();
  });

  it('lets a Manager remove a Contributor', async () => {
    asManager();
    mockDbWrite.collectionContributor.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'ADD'],
    });
    await removeCollaborator({
      collectionId: COLLECTION_ID,
      userId: MANAGER_ID,
      targetUserId: TARGET_ID,
    });
    expect(mockDbWrite.collectionContributor.delete).toHaveBeenCalled();
  });

  it('lets a collaborator remove themselves', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: false,
      manage: false,
      collaborationDisabled: false,
      collectionMode: null,
    });
    await removeCollaborator({
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      targetUserId: TARGET_ID,
    });
    expect(mockDbWrite.collectionContributor.delete).toHaveBeenCalled();
  });

  it('tolerates a not-found error deleting an already-absent contributor row', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: false,
      manage: false,
      collaborationDisabled: false,
      collectionMode: null,
    });
    mockDbWrite.collectionContributor.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: '1',
      })
    );

    await expect(
      removeCollaborator({
        collectionId: COLLECTION_ID,
        userId: TARGET_ID,
        targetUserId: TARGET_ID,
      })
    ).resolves.toBeUndefined();
  });

  it('propagates a non-not-found error deleting the contributor row', async () => {
    mockGetPermissions.mockResolvedValue({
      collectionId: COLLECTION_ID,
      isOwner: false,
      manage: false,
      collaborationDisabled: false,
      collectionMode: null,
    });
    mockDbWrite.collectionContributor.delete.mockRejectedValue(new Error('connection lost'));

    await expect(
      removeCollaborator({
        collectionId: COLLECTION_ID,
        userId: TARGET_ID,
        targetUserId: TARGET_ID,
      })
    ).rejects.toThrow('connection lost');
  });
});

describe('getCollaborators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Public',
      mode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
  });

  it('excludes a plain follower on a write:Public collection from the roster', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: false,
      manage: false,
      read: true,
      collaborationDisabled: false,
      collectionMode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: TARGET_ID, permissions: ['VIEW', 'ADD'] },
    ]);
    mockDbRead.collectionInvite.findMany.mockResolvedValueOnce([]); // accepted lookup: none

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: TARGET_ID });

    expect(result.collaborators).toEqual([]);
  });

  it('shows an invited Manager and an invited Contributor with the right roles', async () => {
    asOwner();
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: MANAGER_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
      // Same {VIEW, ADD} shape a plain follower gets on a write:Public collection — only
      // distinguishable via the Accepted CollectionInvite row queried below.
      { userId: TARGET_ID, permissions: ['VIEW', 'ADD'] },
      { userId: 321, permissions: ['VIEW', 'ADD'] }, // plain follower, never invited
    ]);
    mockDbRead.collectionInvite.findMany
      .mockResolvedValueOnce([{ userId: MANAGER_ID }, { userId: TARGET_ID }]) // accepted lookup
      .mockResolvedValueOnce([]); // pending lookup

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    expect(result.collaborators).toHaveLength(2);
    expect(result.collaborators).toEqual(
      expect.arrayContaining([
        { userId: MANAGER_ID, role: 'Manager' },
        { userId: TARGET_ID, role: 'Contributor' },
      ])
    );
  });

  // A follower's row on a write:Public collection is {VIEW, ADD} — the same shape an accepted
  // Contributor gets — so the seat lookup is the only thing separating them. Rescuing on a
  // Pending seat would publish an invitee in the public header before they ever answered.
  describe('seat rescue on a write:Public collection', () => {
    function arrangeInvite(status: 'Pending' | 'Accepted') {
      asOwner();
      mockDbRead.collectionContributor.findMany.mockResolvedValue([
        { userId: TARGET_ID, permissions: ['VIEW', 'ADD'] },
      ]);
      const invites = [
        { id: 9, userId: TARGET_ID, role: 'Contributor', status, createdAt: new Date() },
      ];
      mockDbRead.collectionInvite.findMany.mockImplementation(
        async ({ where }: { where: { status?: string } }) =>
          invites.filter((invite) => !where.status || invite.status === where.status)
      );
    }

    it('excludes a pending invitee', async () => {
      arrangeInvite('Pending');

      const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

      expect(result.collaborators).toEqual([]);
    });

    it('includes the same row once the invite is accepted', async () => {
      arrangeInvite('Accepted');

      const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

      expect(result.collaborators).toEqual([{ userId: TARGET_ID, role: 'Contributor' }]);
    });
  });

  it('gives a read-only caller an empty invites list', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: false,
      manage: false,
      read: true,
      collaborationDisabled: false,
      collectionMode: null,
    });
    mockDbRead.collectionInvite.findMany.mockResolvedValueOnce([]); // accepted lookup

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: TARGET_ID });

    expect(result.invites).toEqual([]);
    expect(mockDbRead.collectionInvite.findMany).toHaveBeenCalledTimes(1);
  });

  it('gives a manage-holding caller the pending invites', async () => {
    asOwner();
    const createdAt = new Date();
    mockDbRead.collectionInvite.findMany
      .mockResolvedValueOnce([]) // accepted lookup
      .mockResolvedValueOnce([{ id: 9, userId: TARGET_ID, role: 'Contributor', createdAt }]); // pending lookup

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    expect(result.invites).toEqual([{ id: 9, userId: TARGET_ID, role: 'Contributor', createdAt }]);
  });

  it('refuses a caller with no read access', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: false,
      manage: false,
      read: false,
      collaborationDisabled: false,
      collectionMode: null,
    });

    await expect(
      getCollaborators({ collectionId: COLLECTION_ID, userId: TARGET_ID })
    ).rejects.toThrow();
  });

  // D3: Featured Models (id 104) is read:Public, mode null, owned by system user -1, and
  // carries 14 staff ADD/MANAGE rows — the internal curation roster, returned to anonymous
  // callers before this guard.
  it('refuses a system-owned curation collection', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: false,
      manage: false,
      read: true,
      collaborationDisabled: false,
      collectionMode: null,
    });
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: -1,
      read: 'Public',
      write: 'Private',
      mode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: 111, permissions: ['VIEW', 'ADD', 'MANAGE'] },
    ]);

    await expect(getCollaborators({ collectionId: 104 })).rejects.toThrow();
    expect(mockDbRead.collectionContributor.findMany).not.toHaveBeenCalled();
  });

  it('refuses a Contest collection', async () => {
    asOwner();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Review',
      mode: 'Contest',
    });

    await expect(
      getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID })
    ).rejects.toThrow();
  });

  // D1: the owner's own elevated row made them a roster entry, so the modal rendered them
  // twice — once as Owner, once as "Contributor" with a trash icon that always 400s.
  it('excludes the collection owner from the roster', async () => {
    asOwner();
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: MANAGER_ID, permissions: ['VIEW', 'ADD', 'MANAGE'] },
    ]);
    mockDbRead.collectionInvite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    expect(result.collaborators).toEqual([{ userId: MANAGER_ID, role: 'Manager' }]);
    const rosterQuery = mockDbRead.collectionContributor.findMany.mock.calls[0][0];
    expect(rosterQuery.where.userId).toEqual({ not: OWNER_ID });
  });

  // The roster is public on every collection detail page, so it must not widen to the seat
  // window the caps use — that window includes Pending. The cost is that re-inviting an
  // existing collaborator (which flips their invite back to Pending) drops them off the roster
  // of a write:Public collection until they accept again; the caps keep charging for them.
  it('queries accepted seats only, not the cap seat window', async () => {
    asOwner();
    mockDbRead.collectionInvite.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    const inviteQuery = mockDbRead.collectionInvite.findMany.mock.calls[0][0];
    expect(inviteQuery.where.status).toBe('Accepted');
    expect(inviteQuery.where.OR).toBeUndefined();
  });
});

describe('getCollaborators invite gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({
      userId: OWNER_ID,
      read: 'Public',
      write: 'Public',
      mode: null,
    });
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
  });

  // The Manager is blocked, but is never told it is about the owner's membership — that reason
  // names someone else's billing state, so it is collapsed to the generic one for anyone who
  // isn't the owner. The payload is the disclosure surface, not just the copy.
  it('blocks a Manager on a free owner’s collection without naming the reason', async () => {
    asManager();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'free' });

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: MANAGER_ID });

    expect(result.canInvite).toBe(false);
    expect(result.inviteBlockedReason).toBe('collaboration-disabled');
    // The gate is the OWNER's tier, not the inviter's.
    expect(mockGetSessionUser).toHaveBeenCalledWith(OWNER_ID);
  });

  it('tells the owner their membership is what blocks the invite', async () => {
    asOwner();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'free' });

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    expect(result.canInvite).toBe(false);
    expect(result.inviteBlockedReason).toBe('owner-membership');
  });

  it('allows inviting when the owner holds a membership', async () => {
    asManager();
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'bronze' });

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: MANAGER_ID });

    expect(result.canInvite).toBe(true);
    expect(result.inviteBlockedReason).toBe(null);
  });

  it('reports a lapsed collection as collaboration-disabled, not as a membership problem', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: true,
      manage: true,
      read: true,
      collaborationDisabled: true,
      collectionMode: null,
    });
    mockGetSessionUser.mockResolvedValue({ id: OWNER_ID, tier: 'bronze' });

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: OWNER_ID });

    expect(result.inviteBlockedReason).toBe('collaboration-disabled');
  });

  it('lets a moderator invite without consulting the owner’s tier', async () => {
    asManager();

    const result = await getCollaborators({
      collectionId: COLLECTION_ID,
      userId: MANAGER_ID,
      isModerator: true,
    });

    expect(result.canInvite).toBe(true);
    expect(mockGetSessionUser).not.toHaveBeenCalled();
  });

  it('reports no reason to a viewer who cannot manage', async () => {
    mockGetPermissions.mockResolvedValue({
      isOwner: false,
      manage: false,
      read: true,
      collaborationDisabled: false,
      collectionMode: null,
    });

    const result = await getCollaborators({ collectionId: COLLECTION_ID, userId: TARGET_ID });

    expect(result.canInvite).toBe(false);
    expect(result.inviteBlockedReason).toBe(null);
    expect(mockGetSessionUser).not.toHaveBeenCalled();
  });
});

describe('getMyInvites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
    mockDbRead.collectionContributor.findMany.mockResolvedValue([]);
    mockDbRead.collectionItem.groupBy.mockResolvedValue([]);
  });

  it('queries only Pending, non-expired invites — omits Declined and >7-day-old rows', async () => {
    await getMyInvites({ userId: TARGET_ID });

    const args = mockDbRead.collectionInvite.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('Pending');
    const cutoff = args.where.createdAt.gte as Date;
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
    expect(cutoff.getTime()).toBeGreaterThan(Date.now() - 8 * 24 * 60 * 60 * 1000);
  });

  it('reports accepted item count and a collaborator count that includes the owner', async () => {
    mockDbRead.collectionInvite.findMany
      .mockResolvedValueOnce([
        {
          id: 1,
          role: 'Contributor',
          createdAt: new Date(),
          invitedById: OWNER_ID,
          invitedBy: { id: OWNER_ID, username: 'owner', image: null, deletedAt: null },
          collection: {
            id: COLLECTION_ID,
            name: 'Collab',
            userId: OWNER_ID,
            read: 'Public',
            write: 'Private',
            mode: null,
            image: null,
          },
        },
      ])
      // The roster's accepted-invite read shares this mock.
      .mockResolvedValue([]);
    mockDbRead.collectionContributor.findMany.mockResolvedValue([
      { userId: 1, permissions: ['VIEW', 'ADD'] },
      { userId: 2, permissions: ['VIEW', 'ADD', 'MANAGE'] },
    ]);
    mockDbRead.collectionItem.groupBy.mockResolvedValue([
      { collectionId: COLLECTION_ID, _count: { _all: 42 } },
    ]);

    const [invite] = await getMyInvites({ userId: TARGET_ID });

    expect(mockDbRead.collectionItem.groupBy.mock.calls[0][0].where.status).toBe('ACCEPTED');
    expect(invite.collection.itemCount).toBe(42);
    expect(invite.collection.collaboratorCount).toBe(3);
  });

  it('does not expose the collection read/write/mode columns the roster rule needs', async () => {
    mockDbRead.collectionInvite.findMany
      .mockResolvedValueOnce([
        {
          id: 1,
          role: 'Contributor',
          createdAt: new Date(),
          invitedById: OWNER_ID,
          invitedBy: { id: OWNER_ID, username: 'owner', image: null, deletedAt: null },
          collection: {
            id: COLLECTION_ID,
            name: 'Collab',
            userId: OWNER_ID,
            read: 'Private',
            write: 'Private',
            mode: null,
            image: null,
          },
        },
      ])
      .mockResolvedValue([]);

    const [invite] = await getMyInvites({ userId: TARGET_ID });

    expect(Object.keys(invite.collection).sort()).toEqual([
      'collaboratorCount',
      'id',
      'image',
      'itemCount',
      'name',
    ]);
  });
});
