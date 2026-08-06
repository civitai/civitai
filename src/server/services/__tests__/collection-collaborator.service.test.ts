import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as CollectionService from '~/server/services/collection.service';

// `dbRead.collection.findUnique`, `dbRead.collectionContributor.findMany`, and
// `dbWrite.collectionInvite.deleteMany` aren't in the original brief's mock shape but the
// service calls all three (owner-protection lookup, roster query, invite cleanup on
// removal); stubbed here so those calls don't crash the suite. `dbWrite.collection` /
// `dbWrite.collectionContributor.findMany` / `dbWrite.collectionInvite.findMany` back the
// `tx` client used inside `countCollaborators`'s transaction. The owner-lookup default of
// OWNER_ID lets every test that targets someone other than the owner pass through untouched.
const { mockDbRead, mockDbWrite, mockGetPermissions, mockCreateNotification } = vi.hoisted(() => {
  const OWNER_ID = 999;
  return {
    mockDbRead: {
      collection: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ userId: OWNER_ID, read: 'Private', write: 'Private' }),
      },
      collectionContributor: { findMany: vi.fn().mockResolvedValue([]) },
      collectionInvite: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    },
    mockDbWrite: {
      collection: { findUnique: vi.fn() },
      collectionInvite: {
        upsert: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      collectionContributor: {
        upsert: vi.fn(),
        delete: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    mockGetPermissions: vi.fn(),
    mockCreateNotification: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const {
  inviteCollaborator,
  respondToInvite,
  removeCollaborator,
  getCollaborators,
  getMyInvites,
  COLLABORATOR_CAP,
  MANAGER_CAP,
} = await import('~/server/services/collection-collaborator.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const MANAGER_ID = 777;
const TARGET_ID = 555;

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

function arrangeCounts({ collaborators = 0, managers = 0 } = {}) {
  mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
  mockDbWrite.$transaction.mockResolvedValue([collaborators, managers]);
}

describe('inviteCollaborator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collection.findUnique.mockResolvedValue({ userId: OWNER_ID });
    arrangeCounts();
    mockDbWrite.collectionInvite.upsert.mockResolvedValue({ id: 1 });
  });

  it('lets the owner invite a Manager', async () => {
    asOwner();
    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Manager',
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });

  it('notifies the invitee, never the inviter', async () => {
    asOwner();
    mockDbRead.collection.findUnique.mockResolvedValue({ userId: OWNER_ID, name: 'My Collection' });

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });

    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TARGET_ID,
        type: 'collection-invite-received',
        details: { collectionId: COLLECTION_ID, collectionName: 'My Collection' },
      })
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
      })
    ).rejects.toThrow();

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });
    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
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
    mockDbRead.collection.findUnique.mockResolvedValue({ userId: OWNER_ID });
    mockDbWrite.collectionInvite.upsert.mockResolvedValue({ id: 1 });
    asOwner();
  });

  it('still succeeds when the only existing rows are followers on a write:Public collection', async () => {
    // COLLABORATOR_CAP plain followers, each carrying ADD for free (write:Public) — the
    // pre-fix filter (`permissions && ARRAY['ADD','MANAGE']`) would count every one of these
    // toward the cap and reject the invite below; the fix must see zero real collaborators.
    mockDbWrite.collection.findUnique.mockResolvedValue({ read: 'Public', write: 'Public' });
    mockDbWrite.collectionContributor.findMany.mockResolvedValue(
      Array.from({ length: COLLABORATOR_CAP }, (_, i) => ({
        userId: 1000 + i,
        permissions: ['VIEW', 'ADD'],
      }))
    );
    mockDbWrite.collectionInvite.findMany.mockResolvedValue([]);
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        collection: { findUnique: mockDbWrite.collection.findUnique },
        collectionContributor: { findMany: mockDbWrite.collectionContributor.findMany },
        collectionInvite: { findMany: mockDbWrite.collectionInvite.findMany },
      })
    );

    await inviteCollaborator({
      collectionId: COLLECTION_ID,
      userId: OWNER_ID,
      targetUserId: TARGET_ID,
      role: 'Contributor',
    });

    expect(mockDbWrite.collectionInvite.upsert).toHaveBeenCalled();
  });
});

describe('respondToInvite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unions the role bits onto existing follow permissions', async () => {
    mockDbWrite.collectionInvite.findUnique.mockResolvedValue({
      id: 1,
      collectionId: COLLECTION_ID,
      userId: TARGET_ID,
      role: 'Manager',
      status: 'Pending',
      createdAt: new Date(),
    });
    mockDbWrite.collectionContributor.findUnique.mockResolvedValue({
      permissions: ['VIEW', 'ADD_REVIEW'],
    });
    mockDbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        collectionInvite: { update: mockDbWrite.collectionInvite.update },
        collectionContributor: {
          findUnique: mockDbWrite.collectionContributor.findUnique,
          upsert: mockDbWrite.collectionContributor.upsert,
        },
      })
    );

    await respondToInvite({ inviteId: 1, userId: TARGET_ID, accept: true });

    const upsertArgs = mockDbWrite.collectionContributor.upsert.mock.calls[0][0];
    expect(new Set(upsertArgs.update.permissions)).toEqual(
      new Set(['VIEW', 'ADD_REVIEW', 'ADD', 'MANAGE'])
    );
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
    mockDbRead.collection.findUnique.mockResolvedValue({ read: 'Public', write: 'Public' });
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
});

describe('getMyInvites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collectionInvite.findMany.mockResolvedValue([]);
  });

  it('queries only Pending, non-expired invites — omits Declined and >7-day-old rows', async () => {
    await getMyInvites({ userId: TARGET_ID });

    const args = mockDbRead.collectionInvite.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('Pending');
    const cutoff = args.where.createdAt.gte as Date;
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
    expect(cutoff.getTime()).toBeGreaterThan(Date.now() - 8 * 24 * 60 * 60 * 1000);
  });
});
