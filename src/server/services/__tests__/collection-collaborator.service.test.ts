import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as CollectionService from '~/server/services/collection.service';

// `dbRead.collection.findUnique` and `dbWrite.collectionInvite.deleteMany` aren't in the
// brief's mock shape but the service calls both (owner-protection lookup, invite cleanup on
// removal); stubbed here so those calls don't crash the suite. The owner-lookup default of
// OWNER_ID lets every test that targets someone other than the owner pass through untouched.
const { mockDbRead, mockDbWrite, mockGetPermissions } = vi.hoisted(() => {
  const OWNER_ID = 999;
  return {
    mockDbRead: {
      collection: { findUnique: vi.fn().mockResolvedValue({ userId: OWNER_ID }) },
      collectionInvite: { findMany: vi.fn(), findUnique: vi.fn() },
    },
    mockDbWrite: {
      collectionInvite: {
        upsert: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
        deleteMany: vi.fn(),
      },
      collectionContributor: { upsert: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    mockGetPermissions: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
}));

const {
  inviteCollaborator,
  respondToInvite,
  removeCollaborator,
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
    collaborationDisabled: false,
    collectionMode: null,
  });
}

function asManager() {
  mockGetPermissions.mockResolvedValue({
    collectionId: COLLECTION_ID,
    isOwner: false,
    manage: true,
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
});
